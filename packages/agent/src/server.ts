import {
  McpServer,
  type ContentBlock,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  ownField,
  type TackManifest,
  type TackRuntime,
} from "@cbxss/tack-core";
import {
  createExecutionEngine,
  formatTraceLine,
  ExecutionHost,
  publicExecution,
  jsonBytes,
  DELIVERY_LIMITS,
  type CodeRuntime,
  type CreateExecutionEngineOptions,
  type ExecutionResult,
  type OperationPolicy,
  type TraceSink,
  type ToolAuditEvent,
} from "@cbxss/tack-codemode";

export interface CreateTackAgentServerOptions {
  readonly host?: ExecutionHost | undefined;
  readonly stateRoot?: string | undefined;
  readonly responseOwner?: string | undefined;
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly codeRuntime: CodeRuntime;
  readonly policy?: OperationPolicy | undefined;
  readonly onAuditEvent?:
    ((event: ToolAuditEvent) => void | Promise<void>) | undefined;
  readonly typecheck?: CreateExecutionEngineOptions["typecheck"];
}

export function createTackAgentServer(
  options: CreateTackAgentServerOptions,
): McpServer {
  const suppliedHost = ownField<ExecutionHost>(options, "host");
  const stateRoot = ownField<string>(options, "stateRoot");
  const host =
    suppliedHost ?? new ExecutionHost(stateRoot ? { root: stateRoot } : {});
  const manifest = ownField<TackManifest>(options, "manifest")!;
  const policy = ownField<OperationPolicy>(options, "policy");
  const engine = createExecutionEngine({
    manifest,
    runtime: ownField<TackRuntime>(options, "runtime")!,
    codeRuntime: ownField<CodeRuntime>(options, "codeRuntime")!,
    host,
    responseOwner: ownField<string>(options, "responseOwner") ?? "local",
    policy,
    onAuditEvent: ownField(options, "onAuditEvent"),
    typecheck: ownField(options, "typecheck"),
  });
  const server = new McpServer(
    { name: "tack", version: "2.0.0" },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    "execute",
    {
      title: "Execute Tack code",
      description: engine.getDescription(),
      inputSchema: z
        .object({
          code: z.string().trim().min(1),
          typecheck: z
            .enum(["off", "strict"])
            .optional()
            .describe(
              "Optional semantic TypeScript checking, off by default. Omit for routine discovery and investigation; use strict to debug code.",
            ),
        })
        .strict(),
    },
    async ({ code, typecheck }, ctx) => {
      try {
        return formatExecuteMcpResult(
          await engine.execute(code, {
            typecheck,
            signal: ctx.mcpReq.signal,
            onTrace: progressTraceSink(ctx),
          }),
        );
      } catch (error) {
        return formatExecuteMcpResult(
          deliveryError(
            `Execution could not be delivered; do not automatically replay tool calls. ${error instanceof Error ? error.message.slice(0, 1500) : "Internal error"}`,
          ),
        );
      }
    },
  );
  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    if (!suppliedHost) void host.close();
    previousOnClose?.();
  };
  return server;
}

function deliveryError(message: string): ExecutionResult {
  return {
    ok: false,
    emitted: [],
    logs: [],
    error: { phase: "runtime", code: "internal_error", message },
  };
}

/**
 * A trace sink that streams each event to the client as a `notifications/progress`
 * message — but only when the request carried a `progressToken` (i.e. the client
 * asked for progress). Returns `undefined` otherwise so the engine skips tracing.
 */
function progressTraceSink(ctx: ServerContext): TraceSink | undefined {
  const meta = ctx.mcpReq._meta as
    { readonly progressToken?: string | number } | undefined;
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
        params: { progressToken, progress, message: formatTraceLine(event) },
      })
      .catch(() => {
        // A dropped progress notification must not affect the execution.
      });
  };
}

export function formatExecuteMcpResult(result: ExecutionResult): {
  readonly content: ContentBlock[];
  readonly structuredContent: Record<string, unknown>;
  readonly isError?: true;
} {
  const structuredContent = publicExecution(result);
  const output = {
    content: [
      { type: "text" as const, text: JSON.stringify(structuredContent) },
    ],
    structuredContent,
    ...(result.ok ? {} : { isError: true as const }),
  };
  if (
    jsonBytes(structuredContent) > DELIVERY_LIMITS.model ||
    jsonBytes(output) > DELIVERY_LIMITS.wire
  )
    throw new Error("delivery_budget_exceeded");
  return output;
}
