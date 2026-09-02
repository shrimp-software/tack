import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import {
  ownField,
  sanitizeData,
  type TackManifest,
  type TackRuntime
} from "@tack/core";
import type { CodeRuntime, OperationPolicy, ToolAuditEvent } from "@tack/codemode";

import { createTackAgentServer, type CreateTackAgentServerOptions } from "./server.js";

export interface HostedMcpUser {
  readonly id: string;
  readonly token: string;
  readonly allowedOperations?: readonly string[] | undefined;
  readonly deniedOperations?: readonly string[] | undefined;
}

export interface ServeTackMcpHttpOptions {
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly codeRuntime: CodeRuntime;
  readonly users?: readonly HostedMcpUser[] | undefined;
  readonly policy?: OperationPolicy | undefined;
  readonly onAuditEvent?: ((event: ToolAuditEvent) => void | Promise<void>) | undefined;
  readonly typecheck?: CreateTackAgentServerOptions["typecheck"];
}

export interface TackMcpHttpListenOptions {
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly path?: string | undefined;
}

export interface TackMcpHttpHandle {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

interface HostedMcpContext {
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly codeRuntime: CodeRuntime;
  readonly users: readonly HostedMcpUserSnapshot[];
  readonly policy?: OperationPolicy | undefined;
  readonly onAuditEvent?: ServeTackMcpHttpOptions["onAuditEvent"] | undefined;
  readonly typecheck?: CreateTackAgentServerOptions["typecheck"];
}

interface HostedMcpUserSnapshot {
  readonly id: string;
  readonly token?: string | undefined;
  readonly policy?: OperationPolicy | undefined;
}

interface AuthenticatedMcpUser {
  readonly id: string;
  readonly token: string;
}

type McpAuthResult =
  | { readonly status: "open" }
  | { readonly status: "authenticated"; readonly authInfo: AuthInfo }
  | { readonly status: "unauthorized" };

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;
const DEFAULT_PATH = "/mcp";

export function listenTackMcpHttp(
  options: ServeTackMcpHttpOptions,
  listen: TackMcpHttpListenOptions = {}
): Promise<TackMcpHttpHandle> {
  const context = normalizeServeOptions(options);

  const path = normalizePath(ownField(listen, "path") as string | undefined);
  const handler = createHostedMcpHandler(context);
  const server = createServer((request, response) => {
    void handleNodeRequest(context, handler, path, request, response);
  });
  const host = ownField(listen, "host") as string | undefined ?? DEFAULT_HOST;
  const port = ownField(listen, "port") as number | undefined ?? DEFAULT_PORT;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        server,
        url: `http://${host}:${actualPort}${path}`,
        close: async () => {
          await Promise.allSettled([closeServer(server), handler.close()]);
        }
      });
    });
  });
}

function createHostedMcpHandler(context: HostedMcpContext): ReturnType<typeof createMcpHandler> {
  return createMcpHandler((requestContext) => {
    const policy = mergePolicy(
      context.policy,
      userPolicy(context.users, requestContext.authInfo)
    );
    return createTackAgentServer({
      manifest: context.manifest,
      runtime: context.runtime,
      codeRuntime: context.codeRuntime,
      // The handler builds a fresh instance per request, so a session store here
      // could never outlive one call.
      sessions: false,
      ...(policy ? { policy } : {}),
      ...(context.onAuditEvent ? { onAuditEvent: context.onAuditEvent } : {}),
      ...(context.typecheck ? { typecheck: context.typecheck } : {})
    });
  });
}

function normalizeServeOptions(options: ServeTackMcpHttpOptions): HostedMcpContext {
  const manifest = ownField(options, "manifest") as TackManifest;
  const runtime = ownField(options, "runtime") as TackRuntime;
  const codeRuntime = ownField(options, "codeRuntime") as CodeRuntime;
  const users = sanitizeData(ownField(options, "users"), {}) as readonly HostedMcpUser[] | undefined;
  const policy = ownField(options, "policy") as OperationPolicy | undefined;
  const onAuditEvent = ownField(options, "onAuditEvent") as ServeTackMcpHttpOptions["onAuditEvent"];
  const typecheck = ownField(options, "typecheck") as ServeTackMcpHttpOptions["typecheck"];
  return {
    manifest,
    runtime,
    codeRuntime,
    users: Array.isArray(users) ? users.map(normalizeUser) : [],
    ...(policy ? { policy } : {}),
    ...(onAuditEvent ? { onAuditEvent } : {}),
    ...(typecheck ? { typecheck } : {})
  };
}

async function handleNodeRequest(
  context: HostedMcpContext,
  handler: ReturnType<typeof createMcpHandler>,
  path: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    const url = requestUrl(request);
    if (url.pathname !== path) {
      writeText(response, 404, "not found");
      return;
    }

    if (!hasAllowedOrigin(request)) {
      writeText(response, 403, "forbidden origin");
      return;
    }

    const auth = resolveAuth(context, request.headers["authorization"]);
    if (auth.status === "unauthorized") {
      response.setHeader("www-authenticate", "Bearer");
      writeText(response, 401, "unauthorized");
      return;
    }

    const mcpResponse = await handler.fetch(
      toWebRequest(request, url),
      auth.status === "authenticated" ? { authInfo: auth.authInfo } : {}
    );
    await writeWebResponse(response, mcpResponse);
  } catch (error) {
    writeText(response, 500, error instanceof Error ? error.message : String(error));
  }
}

function requestUrl(request: IncomingMessage): URL {
  const host = headerValue(request.headers.host) ?? "127.0.0.1";
  return new URL(request.url ?? "/", `http://${host}`);
}

function hasAllowedOrigin(request: IncomingMessage): boolean {
  const origin = headerValue(request.headers.origin);
  if (!origin) {
    return true;
  }

  const host = headerValue(request.headers.host);
  if (!host) {
    return false;
  }

  const originHostname = parseHostname(origin);
  const hostHostname = parseHostname(`http://${host}`);
  return originHostname !== undefined &&
    hostHostname !== undefined &&
    originHostname === hostHostname;
}

function parseHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function toWebRequest(request: IncomingMessage, url: URL): Request {
  const method = request.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: requestHeaders(request)
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }

  return new Request(url, init);
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name && value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
}

async function writeWebResponse(response: ServerResponse, source: Response): Promise<void> {
  response.statusCode = source.status;
  response.statusMessage = source.statusText;
  source.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });

  if (!source.body) {
    response.end();
    return;
  }

  await pipeline(Readable.fromWeb(source.body as ReadableStream<Uint8Array>), response);
}

function writeText(response: ServerResponse, status: number, text: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(text);
}

function normalizeUser(user: HostedMcpUser): HostedMcpUserSnapshot {
  const { id, token } = user;
  const allowedOperations = stringArray(user.allowedOperations);
  const deniedOperations = stringArray(user.deniedOperations);
  const policy = mergePolicy(undefined, {
    ...(allowedOperations ? { allowedOperations } : {}),
    ...(deniedOperations ? { deniedOperations } : {})
  });
  return {
    id: typeof id === "string" ? id : "",
    ...(typeof token === "string" ? { token } : {}),
    ...(policy ? { policy } : {})
  };
}

function authenticate(
  users: readonly HostedMcpUserSnapshot[],
  authorization: string | readonly string[] | undefined
): AuthenticatedMcpUser | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) {
    return undefined;
  }

  for (const user of users) {
    if (typeof user.token === "string" && safeEqual(token, user.token)) {
      return {
        id: user.id,
        token
      };
    }
  }

  return undefined;
}

function resolveAuth(
  context: HostedMcpContext,
  authorization: string | readonly string[] | undefined
): McpAuthResult {
  if (context.users.length === 0) {
    return { status: "open" };
  }

  const user = authenticate(context.users, authorization);
  if (!user) {
    return { status: "unauthorized" };
  }

  return {
    status: "authenticated",
    authInfo: {
      token: user.token,
      clientId: user.id,
      scopes: [],
      extra: {
        userId: user.id
      }
    }
  };
}

function userPolicy(
  users: readonly HostedMcpUserSnapshot[],
  authInfo: AuthInfo | undefined
): OperationPolicy | undefined {
  const clientId = authInfo?.clientId;
  return users.find((user) => user.id === clientId)?.policy;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
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

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : undefined;
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string" || value === undefined) {
    return value;
  }

  return value.at(0);
}

function normalizePath(path: string | undefined): string {
  if (!path) {
    return DEFAULT_PATH;
  }

  return path.startsWith("/") ? path : `/${path}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
