import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  ownField,
  sanitizeData,
  type TackManifest,
  type TackRuntime
} from "@tack/core";
import {
  createExecutionEngine,
  searchOperations,
  type CodeRuntime,
  type OperationPolicy,
  type ToolAuditEvent
} from "@tack/codemode";

export interface ServiceRateLimit {
  readonly requests: number;
  readonly windowMs: number;
}

export interface ServiceUser {
  readonly id: string;
  readonly token: string;
  readonly allowedOperations?: readonly string[] | undefined;
  readonly deniedOperations?: readonly string[] | undefined;
  readonly rateLimit?: ServiceRateLimit | undefined;
}

export interface CreateTackHttpServiceOptions {
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly codeRuntime: CodeRuntime;
  readonly users: readonly ServiceUser[];
  readonly policy?: OperationPolicy | undefined;
  readonly maxRequestBytes?: number | undefined;
  readonly rateLimit?: ServiceRateLimit | undefined;
  readonly onAuditEvent?: ((event: ServiceAuditEvent) => void | Promise<void>) | undefined;
}

export interface TackHttpListenOptions {
  readonly host?: string | undefined;
  readonly port?: number | undefined;
}

export interface TackHttpServiceHandle {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

export type ServiceAuditEvent = ToolAuditEvent & {
  readonly userId?: string | undefined;
};

interface AuthenticatedUser {
  readonly id: string;
  readonly policy?: OperationPolicy | undefined;
  readonly rateLimit?: ServiceRateLimit | undefined;
}

interface ServiceUserSnapshot {
  readonly id: string;
  readonly token?: string | undefined;
  readonly policy?: OperationPolicy | undefined;
  readonly rateLimit?: ServiceRateLimit | undefined;
}

interface RateWindow {
  resetAt: number;
  count: number;
}

const DEFAULT_MAX_REQUEST_BYTES = 1_000_000;

interface ServiceContext {
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly codeRuntime: CodeRuntime;
  readonly users: readonly ServiceUserSnapshot[];
  readonly policy?: OperationPolicy | undefined;
  readonly maxRequestBytes: number;
  readonly onAuditEvent?: CreateTackHttpServiceOptions["onAuditEvent"] | undefined;
}

function createTackHttpService(
  options: CreateTackHttpServiceOptions
): Server {
  const context = normalizeServiceContext(options);
  if (context.users.length === 0) {
    throw new Error("Tack HTTP service requires at least one configured user token");
  }
  const isolation = context.codeRuntime.isolation;
  if (isolation === "none") {
    const name = context.codeRuntime.name;
    throw new Error(
      `Tack HTTP service refuses code runtime "${typeof name === "string" ? name : "unknown"}" because it has no isolation. ` +
      "Use the quickjs or workerd runtime for exposed services."
    );
  }

  const limiter = createRateLimiter(normalizeRateLimit(ownField(options, "rateLimit")));
  return createServer((request, response) => {
    void handleRequest(context, limiter, request, response);
  });
}

export function listenTackHttpService(
  options: CreateTackHttpServiceOptions,
  listen: TackHttpListenOptions = {}
): Promise<TackHttpServiceHandle> {
  const server = createTackHttpService(options);
  const host = ownField<string>(listen, "host") ?? "127.0.0.1";
  const port = ownField<number>(listen, "port") ?? 8787;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        server,
        url: `http://${host}:${actualPort}`,
        close: () => closeServer(server)
      });
    });
  });
}

async function handleRequest(
  context: ServiceContext,
  limiter: ReturnType<typeof createRateLimiter>,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, { ok: true });
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  const user = authenticate(context.users, request.headers["authorization"]);
  if (!user) {
    writeJson(response, 401, { error: "unauthorized" });
    return;
  }

  const rate = limiter.check(user);
  if (!rate.allowed) {
    response.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
    writeJson(response, 429, { error: "rate_limited", retryAfterMs: rate.retryAfterMs });
    return;
  }

  try {
    const body = await readBody(request, context.maxRequestBytes);
    const policy = mergePolicy(context.policy, user.policy);
    const onAuditEvent = createUserAuditSink(
      user.id,
      context.onAuditEvent
    );

    if (request.url === "/search") {
      writeJson(response, 200, searchOperations(context.manifest, normalizeSearchBody(body), policy));
      return;
    }

    if (request.url === "/execute") {
      const code = readString(body, "code");
      if (!code) {
        writeJson(response, 400, { error: "code_required" });
        return;
      }

      const engine = createExecutionEngine({
        manifest: context.manifest,
        runtime: context.runtime,
        codeRuntime: context.codeRuntime,
        ...(policy ? { policy } : {}),
        ...(onAuditEvent ? { onAuditEvent } : {})
      });
      const result = await engine.execute(code);
      writeJson(response, result.ok ? 200 : 400, result);
      return;
    }

    writeJson(response, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      writeJson(response, 413, {
        error: "request_too_large",
        maxRequestBytes: error.maxBytes
      });
      return;
    }

    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function normalizeServiceContext(options: CreateTackHttpServiceOptions): ServiceContext {
  const policy = ownField<OperationPolicy>(options, "policy");
  const onAuditEvent = ownField<CreateTackHttpServiceOptions["onAuditEvent"]>(options, "onAuditEvent");
  return {
    manifest: ownField<TackManifest>(options, "manifest") as TackManifest,
    runtime: ownField<TackRuntime>(options, "runtime") as TackRuntime,
    codeRuntime: ownField<CodeRuntime>(options, "codeRuntime") as CodeRuntime,
    users: optionUsers(options).map(normalizeServiceUser),
    ...(policy ? { policy } : {}),
    maxRequestBytes: ownField<number>(options, "maxRequestBytes") ?? DEFAULT_MAX_REQUEST_BYTES,
    ...(onAuditEvent ? { onAuditEvent } : {})
  };
}

function normalizeServiceUser(user: ServiceUser): ServiceUserSnapshot {
  const { id, token } = user;
  const allowedOperations = stringArray(user.allowedOperations);
  const deniedOperations = stringArray(user.deniedOperations);
  const policy = mergePolicy(undefined, {
    ...(allowedOperations ? { allowedOperations } : {}),
    ...(deniedOperations ? { deniedOperations } : {})
  });
  const rateLimit = normalizeRateLimit(user.rateLimit);
  return {
    id: typeof id === "string" ? id : "",
    ...(typeof token === "string" ? { token } : {}),
    ...(policy ? { policy } : {}),
    ...(rateLimit ? { rateLimit } : {})
  };
}

function authenticate(
  users: readonly ServiceUserSnapshot[],
  authorization: string | readonly string[] | undefined
): AuthenticatedUser | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) {
    return undefined;
  }

  for (const user of users) {
    if (typeof user.token === "string" && safeEqual(token, user.token)) {
      return {
        id: user.id,
        ...(user.policy ? { policy: user.policy } : {}),
        ...(user.rateLimit ? { rateLimit: user.rateLimit } : {})
      };
    }
  }

  return undefined;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function createRateLimiter(defaultLimit: ServiceRateLimit | undefined) {
  const windows = new Map<string, RateWindow>();

  return {
    check(user: AuthenticatedUser): { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number } {
      const limit = user.rateLimit ?? defaultLimit;
      if (!limit) {
        return { allowed: true };
      }
      const { requests, windowMs } = limit;

      const now = Date.now();
      const window = windows.get(user.id);
      if (!window || now >= window.resetAt) {
        windows.set(user.id, { count: 1, resetAt: now + windowMs });
        return { allowed: true };
      }

      if (window.count >= requests) {
        return { allowed: false, retryAfterMs: Math.max(0, window.resetAt - now) };
      }

      window.count += 1;
      return { allowed: true };
    }
  };
}

function mergePolicy(
  base: OperationPolicy | undefined,
  user: OperationPolicy | undefined
): OperationPolicy | undefined {
  if (!base && !user) {
    return undefined;
  }

  if (base && user) {
    return { allOf: [base, user] };
  }

  return base ?? user;
}

function normalizeRateLimit(value: unknown): ServiceRateLimit | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const requests = record["requests"];
  const windowMs = record["windowMs"];
  return typeof requests === "number" && typeof windowMs === "number"
    ? { requests, windowMs }
    : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : undefined;
}

function createUserAuditSink(
  userId: string,
  sink: CreateTackHttpServiceOptions["onAuditEvent"]
): ((event: ToolAuditEvent) => Promise<void>) | undefined {
  if (!sink) {
    return undefined;
  }

  return async (event) => {
    await sink({ ...event, userId });
  };
}

function normalizeSearchBody(input: unknown) {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as { readonly query: string }
    : { query: "" };
}

function readString(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }

  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let settled = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (settled) {
        return;
      }

      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        settled = true;
        reject(new RequestBodyTooLargeError(maxBytes));
        return;
      }

      body += chunk;
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    request.on("end", () => {
      if (settled) {
        return;
      }

      settled = true;
      try {
        resolve(sanitizeData(body.length > 0 ? JSON.parse(body) as unknown : {}, {}));
      } catch (error) {
        reject(error);
      }
    });
  });
}

class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeded ${maxBytes} bytes`);
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function optionUsers(options: CreateTackHttpServiceOptions): ServiceUser[] {
  const users = sanitizeData(ownField(options, "users"), {});
  return Array.isArray(users) ? (users as ServiceUser[]) : [];
}
