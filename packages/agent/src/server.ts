import { Buffer } from "node:buffer";
import {
  isSpecType,
  McpServer,
  type ContentBlock,
  type ServerContext
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  ownField,
  type TackManifest,
  type TackRuntime
} from "@tack/core";
import {
  createExecutionEngine,
  formatTraceLine,
  isTackRef,
  type CodeRuntime,
  type CreateExecutionEngineOptions,
  type ExecutionResult,
  type ExecutionSession,
  type OperationPolicy,
  type TraceSink
} from "@tack/codemode";
import type { ToolAuditEvent } from "@tack/codemode";

export interface CreateTackAgentServerOptions {
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly codeRuntime: CodeRuntime;
  readonly policy?: OperationPolicy | undefined;
  readonly onAuditEvent?: ((event: ToolAuditEvent) => void | Promise<void>) | undefined;
  /**
   * Persistent code-mode sessions need one server instance per connection. Set
   * `false` for stateless-per-request transports (the hosted HTTP handler does);
   * the `session` tool then refuses instead of handing out unusable ids.
   * Defaults to `true`.
   */
  readonly sessions?: boolean | undefined;
}

export function createTackAgentServer(
  options: CreateTackAgentServerOptions
): McpServer {
  const manifest = ownField(options, "manifest") as TackManifest;
  const runtime = ownField(options, "runtime") as TackRuntime;
  const codeRuntime = ownField(options, "codeRuntime") as CodeRuntime;
  const policy = ownField(options, "policy") as OperationPolicy | undefined;
  const onAuditEvent = ownField(options, "onAuditEvent") as CreateTackAgentServerOptions["onAuditEvent"];
  const sessionsAllowed = ownField(options, "sessions") !== false;
  const engineOptions: CreateExecutionEngineOptions = {
    manifest,
    runtime,
    codeRuntime,
    ...(policy ? { policy } : {}),
    ...(onAuditEvent ? { onAuditEvent } : {})
  };
  const engine = createExecutionEngine(engineOptions);
  const sessions = new SessionStore(engine);
  const sessionsSupported = sessionsAllowed && engine.supportsSessions;
  const server = new McpServer(
    { name: "tack", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // The connection's implicit session: a bare `execute` runs in it so scope
  // carries across calls with no `session` ceremony. Recreated if it expired.
  let defaultSessionId: string | undefined;
  const defaultSession = async (fresh: boolean): Promise<ExecutionSession | undefined> => {
    if (fresh && defaultSessionId !== undefined) {
      await sessions.close(defaultSessionId);
      defaultSessionId = undefined;
    }
    if (defaultSessionId !== undefined) {
      const existing = sessions.get(defaultSessionId);
      if (existing) {
        return existing;
      }
    }
    try {
      defaultSessionId = await sessions.open();
    } catch {
      return undefined;
    }
    return sessions.get(defaultSessionId);
  };

  const executeDescription = engine.getDescription();

  server.registerTool(
    "execute",
    {
      title: "Execute Tack code",
      description: executeDescription,
      inputSchema: z.object({
        code: z.string().trim().min(1),
        session: z
          .string()
          .optional()
          .describe("Run in a specific session id. Omit to use this connection's persistent session."),
        fresh: z
          .boolean()
          .optional()
          .describe("Start the connection's persistent session from a clean scope.")
      })
    },
    async ({ code, session, fresh }, ctx) => {
      const onTrace = progressTraceSink(ctx);
      const execOptions = onTrace ? { onTrace } : undefined;
      try {
        if (session !== undefined) {
          if (!sessionsSupported) {
            return formatExecuteMcpResult(sessionError(SESSIONS_UNAVAILABLE));
          }
          const entry = sessions.get(session);
          if (!entry) {
            return formatExecuteMcpResult(sessionError(`Unknown session "${session}"`));
          }
          return formatExecuteMcpResult(await entry.exec(code, execOptions), session);
        }

        if (sessionsSupported) {
          const entry = await defaultSession(fresh === true);
          if (entry) {
            return formatExecuteMcpResult(await entry.exec(code, execOptions), defaultSessionId);
          }
        }

        const perCall = onTrace ? createExecutionEngine({ ...engineOptions, onTrace }) : engine;
        return formatExecuteMcpResult(await perCall.execute(code));
      } catch {
        return formatExecuteMcpResult(sessionError("Internal execute error"));
      }
    }
  );

  server.registerTool(
    "deref",
    {
      title: "Read a retained code-mode ref",
      description: "Retrieve a value an `execute` cell kept as a ref (e.g. `$1`). Defaults to this connection's session; arrays and strings page by `offset`/`limit`.",
      inputSchema: z.object({
        ref: z.string().regex(/^\$(\d+|_)$/, 'ref must be "$1", "$2", … or "$_"'),
        session: z.string().optional().describe("Session id (from an `execute` result). Omit for this connection's session."),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(1000).optional()
      })
    },
    async ({ session, ref, offset, limit }) => {
      if (!sessionsSupported) {
        return { content: [{ type: "text", text: SESSIONS_UNAVAILABLE }], isError: true };
      }
      const targetId = session ?? defaultSessionId;
      const entry = targetId === undefined ? undefined : sessions.get(targetId);
      if (!entry) {
        return {
          content: [{ type: "text", text: `No session "${targetId ?? "(none)"}" — run \`execute\` first.` }],
          isError: true
        };
      }
      const result = await entry.deref(ref, {
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit })
      });
      if (!result.ok) {
        return { content: [{ type: "text", text: result.error ?? "deref failed" }], isError: true };
      }
      return {
        content: [{ type: "text", text: valueText(result.value) }],
        structuredContent: { value: result.value, truncated: result.truncated ?? false }
      };
    }
  );

  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    void sessions.closeAll();
    previousOnClose?.();
  };

  return server;
}

const SESSION_IDLE_MS = 5 * 60_000;
const SESSION_MAX_LIFETIME_MS = 30 * 60_000;
const MAX_SESSIONS = 8;
const SESSIONS_UNAVAILABLE =
  "Sessions need a persistent connection (stdio MCP) and a session-capable runtime. This endpoint does not provide one; use one-shot `execute` instead.";

/** Connection-scoped store of live {@link ExecutionSession}s with idle expiry. */
class SessionStore {
  private readonly entries = new Map<string, { session: ExecutionSession; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly engine: ReturnType<typeof createExecutionEngine>) {}

  async open(): Promise<string> {
    if (this.entries.size >= MAX_SESSIONS) {
      throw new Error(`Too many open sessions (max ${MAX_SESSIONS})`);
    }
    const session = await this.engine.createSession({ maxLifetimeMs: SESSION_MAX_LIFETIME_MS });
    this.entries.set(session.id, { session, timer: this.arm(session.id) });
    return session.id;
  }

  get(id: string): ExecutionSession | undefined {
    const entry = this.entries.get(id);
    if (!entry) {
      return undefined;
    }
    clearTimeout(entry.timer);
    entry.timer = this.arm(id);
    return entry.session;
  }

  async close(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    this.entries.delete(id);
    await entry.session.close();
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.close(id)));
  }

  private arm(id: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      void this.close(id);
    }, SESSION_IDLE_MS);
    timer.unref?.();
    return timer;
  }
}

function sessionError(message: string): ExecutionResult {
  return { ok: false, emitted: [], logs: [], error: { phase: "runtime", message } };
}

/**
 * A trace sink that streams each event to the client as a `notifications/progress`
 * message — but only when the request carried a `progressToken` (i.e. the client
 * asked for progress). Returns `undefined` otherwise so the engine skips tracing.
 */
function progressTraceSink(ctx: ServerContext): TraceSink | undefined {
  const meta = ctx.mcpReq._meta as { readonly progressToken?: string | number } | undefined;
  const progressToken = meta?.progressToken;
  if (progressToken === undefined) {
    return undefined;
  }

  let progress = 0;
  return (event) => {
    progress += 1;
    void ctx.mcpReq
      .notify({
        method: "notifications/progress",
        params: { progressToken, progress, message: formatTraceLine(event) }
      })
      .catch(() => {
        // A dropped progress notification must not affect the execution.
      });
  };
}

const MAX_PREVIEW_CHARS = 30_000;
const TEXT_FILE_CONTENT_MAX_CHARS = 64_000;
const TEXT_FILE_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/yaml",
  "application/x-yaml"
]);

interface ToolFileValue {
  readonly _tag: "ToolFile";
  readonly name?: string | undefined;
  readonly mimeType: string;
  readonly encoding: "base64";
  readonly data: string;
  readonly byteLength: number;
}

type ExecuteMcpStructuredContent =
  | {
    readonly status: "completed";
    readonly result: unknown;
    readonly session?: string | undefined;
    readonly emitted?: number | undefined;
    readonly logs: readonly string[];
  }
  | {
    readonly status: "error";
    readonly error: NonNullable<ExecutionResult["error"]>;
    readonly session?: string | undefined;
    readonly emitted?: number | undefined;
    readonly logs: readonly string[];
  };

function formatExecuteMcpResult(result: ExecutionResult, session?: string): {
  readonly content: ContentBlock[];
  readonly structuredContent: ExecuteMcpStructuredContent;
  readonly isError?: true;
} {
  const content = result.emitted.flatMap(emittedContent);
  const text = executionText(result, content.length);
  if (text) {
    content.push({ type: "text", text });
  }

  return {
    content: content.length > 0 ? content : [{ type: "text", text: "(no result)" }],
    structuredContent: executeStructuredContent(result, session),
    ...(result.ok ? {} : { isError: true as const })
  };
}

function executeStructuredContent(result: ExecutionResult, session?: string): ExecuteMcpStructuredContent {
  const emitted = result.emitted.length > 0 ? { emitted: result.emitted.length } : {};
  const sessionField = session !== undefined ? { session } : {};
  if (!result.ok) {
    return {
      status: "error",
      error: result.error ?? {
        phase: "runtime",
        message: "Execution failed"
      },
      ...sessionField,
      ...emitted,
      logs: result.logs
    };
  }

  return {
    status: "completed",
    result: "result" in result ? result.result ?? null : null,
    ...sessionField,
    ...emitted,
    logs: result.logs
  };
}

function emittedContent(value: unknown): ContentBlock[] {
  if (isSpecType.ContentBlock(value)) {
    return [value];
  }

  if (isToolFile(value)) {
    return toolFileContent(value);
  }

  return [{ type: "text", text: truncatePreview(valueText(value), MAX_PREVIEW_CHARS, previewSuffix) }];
}

function executionText(result: ExecutionResult, emittedCount: number): string | undefined {
  const parts: string[] = [];
  if (result.error) {
    parts.push(truncatePreview(`Error: ${result.error.phase}: ${result.error.message}`, MAX_PREVIEW_CHARS, previewSuffix));
  } else if (emittedCount === 0 && isTackRef(result.result)) {
    const ref = result.result;
    parts.push(
      `\`${ref.__tackRef}\` — ${ref.type}\n${truncatePreview(valueText(ref.preview), MAX_PREVIEW_CHARS, previewSuffix)}\n` +
        `(retained; use \`${ref.__tackRef}\` in the next cell, or deref({ session, ref: "${ref.__tackRef}" }))`
    );
  } else if (emittedCount === 0 && "result" in result) {
    parts.push(truncatePreview(valueText(result.result), MAX_PREVIEW_CHARS, previewSuffix));
  } else if (emittedCount === 0) {
    parts.push("(no result)");
  }

  if (result.logs.length > 0) {
    parts.push(`Logs:\n${truncatePreview(result.logs.join("\n"), MAX_PREVIEW_CHARS, previewSuffix)}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function valueText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncatePreview(text: string, maxChars: number, suffix: (truncatedChars: number) => string): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}${suffix(text.length - maxChars)}`
    : text;
}

function previewSuffix(truncatedChars: number): string {
  return `\n... [truncated ${truncatedChars} chars]`;
}

function textFileSuffix(truncatedChars: number): string {
  return `\n\n[truncated ${truncatedChars} characters]`;
}

function isToolFile(value: unknown): value is ToolFileValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const file = value as {
    readonly _tag?: unknown;
    readonly mimeType?: unknown;
    readonly encoding?: unknown;
    readonly data?: unknown;
    readonly byteLength?: unknown;
  };
  return file._tag === "ToolFile" &&
    typeof file.mimeType === "string" &&
    file.encoding === "base64" &&
    typeof file.data === "string" &&
    typeof file.byteLength === "number" &&
    Number.isFinite(file.byteLength) &&
    file.byteLength >= 0;
}

function toolFileContent(file: ToolFileValue): ContentBlock[] {
  return [
    { type: "text", text: `File output: ${toolFileSummary(file)}` },
    ...toolFileDataContent(file)
  ];
}

function toolFileDataContent(file: ToolFileValue): ContentBlock[] {
  const mimeType = normalizedMimeType(file);
  if (mimeType.startsWith("image/")) {
    return [{ type: "image", data: file.data, mimeType: file.mimeType }];
  }

  if (mimeType.startsWith("audio/")) {
    return [{ type: "audio", data: file.data, mimeType: file.mimeType }];
  }

  if (isTextMimeType(mimeType)) {
    return [{ type: "text", text: decodeTextFile(file) }];
  }

  return [
    {
      type: "resource",
      resource: {
        uri: `tack-file:///${encodeURIComponent(file.name ?? "tool-output")}`,
        mimeType: file.mimeType,
        blob: file.data
      }
    }
  ];
}

function toolFileSummary(file: ToolFileValue): string {
  return `${file.name ?? "tool-output"} (${file.mimeType}, ${file.byteLength} bytes)`;
}

function normalizedMimeType(file: ToolFileValue): string {
  return file.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith("text/") ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml") ||
    TEXT_FILE_MIME_TYPES.has(mimeType);
}

function decodeTextFile(file: ToolFileValue): string {
  const text = Buffer.from(file.data, "base64").toString("utf8");
  return truncatePreview(text, TEXT_FILE_CONTENT_MAX_CHARS, textFileSuffix);
}
