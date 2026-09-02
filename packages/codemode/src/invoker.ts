import {
  findOperation,
  operationArgs,
  ownField,
  type TackManifest,
  type TackRuntime
} from "@cbxss/tack-core";

import { describeTool, normalizeDescribeToolInput } from "./describe.js";
import { isOperationAllowed, type OperationPolicy } from "./policy.js";
import { attachTypeScript, listNamespaces, normalizeSearchInput, searchOperations } from "./search.js";
import type { BuiltinTraceEvent, ToolCallOutput, ToolInvoker, ToolTraceEvent } from "./types.js";

export interface CreateTackToolInvokerOptions {
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly policy?: OperationPolicy | undefined;
  readonly executionId?: string | undefined;
  readonly onTraceEvent?: ((event: ToolTraceEvent) => void | Promise<void>) | undefined;
  readonly onAuditEvent?: ((event: ToolAuditEvent) => void | Promise<void>) | undefined;
}

export type ToolAuditEvent = Extract<ToolTraceEvent, { readonly type: "tool_call" }>;

interface BuiltinCallError {
  readonly ok: false;
  readonly error: {
    readonly message: string;
  };
}

interface ToolInvokerContext {
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly policy?: OperationPolicy | undefined;
  readonly executionId?: string | undefined;
  readonly onTraceEvent?: CreateTackToolInvokerOptions["onTraceEvent"] | undefined;
  readonly onAuditEvent?: CreateTackToolInvokerOptions["onAuditEvent"] | undefined;
}

export function createTackToolInvoker(
  options: CreateTackToolInvokerOptions
): ToolInvoker {
  const context = normalizeToolInvokerContext(options);
  return {
    invoke: async (input) => {
      const pathInput = ownField<unknown>(input, "path");
      const path = typeof pathInput === "string" ? pathInput : "";
      const args = ownField<unknown>(input, "args");
      if (path === "search") {
        return traceBuiltin(context, "search", async () => {
          const searchInput = normalizeSearchInput(args);
          // A bare `search({ query: "" })` returns the namespace index — the
          // top-level catalog view — instead of the full flat operation list.
          if (searchInput.query.length === 0 && searchInput.namespace === undefined) {
            return listNamespaces(context.manifest, context.policy);
          }
          const result = searchOperations(context.manifest, searchInput, context.policy);
          // `types` compiles a schema pair per item — only honored with a
          // `namespace` so it can never fan out over the whole catalog.
          return searchInput.types === true && searchInput.namespace !== undefined
            ? attachTypeScript(result, context.manifest)
            : result;
        });
      }

      if (path === "describe.tool") {
        return traceBuiltin(context, "describe.tool", () =>
          describeTool(context.manifest, normalizeDescribeToolInput(args), context.policy)
        );
      }

      return invokeOperation(context, path, args);
    }
  };
}

function normalizeToolInvokerContext(options: CreateTackToolInvokerOptions): ToolInvokerContext {
  const policy = ownField<OperationPolicy>(options, "policy");
  const executionId = ownField<string>(options, "executionId");
  const onTraceEvent = ownField<CreateTackToolInvokerOptions["onTraceEvent"]>(options, "onTraceEvent");
  const onAuditEvent = ownField<CreateTackToolInvokerOptions["onAuditEvent"]>(options, "onAuditEvent");
  return {
    manifest: ownField<TackManifest>(options, "manifest") as TackManifest,
    runtime: ownField<TackRuntime>(options, "runtime") as TackRuntime,
    ...(policy ? { policy } : {}),
    ...(executionId ? { executionId } : {}),
    ...(onTraceEvent ? { onTraceEvent } : {}),
    ...(onAuditEvent ? { onAuditEvent } : {})
  };
}

async function traceBuiltin<T>(
  context: ToolInvokerContext,
  path: BuiltinTraceEvent["path"],
  run: () => T | Promise<T>
): Promise<T | BuiltinCallError> {
  const started = Date.now();
  try {
    const result = await run();
    await emitTrace(context, {
      type: "builtin_call",
      path,
      ok: true,
      durationMs: Date.now() - started
    });
    return result;
  } catch (error) {
    await emitTrace(context, {
      type: "builtin_call",
      path,
      ok: false,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error)
    });
    return builtinCallError(error instanceof Error ? error.message : String(error));
  }
}

async function invokeOperation(
  context: ToolInvokerContext,
  path: string,
  args: unknown
): Promise<ToolCallOutput> {
  const started = Date.now();
  const manifest = context.manifest;
  const operation = findOperation(manifest, path);
  if (!operation) {
    await emitAudit(context, {
      type: "tool_call",
      timestamp: new Date().toISOString(),
      path,
      allowed: false,
      ok: false,
      durationMs: Date.now() - started,
      error: `Unknown Tack operation: ${path}`
    });
    return toolCallError(`Unknown Tack operation: ${path}`);
  }

  const decision = isOperationAllowed(operation, context.policy);
  if (!decision.allowed) {
    await emitAudit(context, {
      type: "tool_call",
      timestamp: new Date().toISOString(),
      path: operation.fullPathString,
      toolId: operation.toolId,
      allowed: false,
      ok: false,
      durationMs: Date.now() - started,
      error: decision.reason
    });
    return toolCallError(decision.reason ?? `Operation denied by policy: ${operation.fullPathString}`);
  }

  await emitTrace(context, {
    type: "tool_call_start",
    timestamp: new Date().toISOString(),
    path: operation.fullPathString,
    toolId: operation.toolId
  });

  try {
    const result = await context.runtime.invoke(operation.toolId, operationArgs(operation, args));
    const text = result.text();
    if (result.isError) {
      await emitAudit(context, {
        type: "tool_call",
        timestamp: new Date().toISOString(),
        path: operation.fullPathString,
        toolId: operation.toolId,
        allowed: true,
        ok: false,
        durationMs: Date.now() - started,
        error: text || `Tool returned an error: ${operation.fullPathString}`
      });
      return {
        ok: false,
        text,
        raw: result.raw,
        error: { message: text || `Tool returned an error: ${operation.fullPathString}` }
      };
    }

    await emitAudit(context, {
      type: "tool_call",
      timestamp: new Date().toISOString(),
      path: operation.fullPathString,
      toolId: operation.toolId,
      allowed: true,
      ok: true,
      durationMs: Date.now() - started
    });
    return {
      ok: true,
      data: result.structuredContent ?? parseJsonText(text) ?? text,
      text,
      raw: result.raw
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : `Failed to call ${operation.fullPathString}`;
    await emitAudit(context, {
      type: "tool_call",
      timestamp: new Date().toISOString(),
      path: operation.fullPathString,
      toolId: operation.toolId,
      allowed: true,
      ok: false,
      durationMs: Date.now() - started,
      error: message
    });
    return toolCallError(message);
  }
}

async function emitAudit(
  context: ToolInvokerContext,
  event: ToolAuditEvent
): Promise<void> {
  await emitTrace(context, event);

  if (!context.onAuditEvent) {
    return;
  }

  try {
    await context.onAuditEvent(context.executionId ? {
      ...event,
      executionId: context.executionId
    } : event);
  } catch {
    // Audit sinks must not change tool-call behavior.
  }
}

async function emitTrace(
  context: ToolInvokerContext,
  event: ToolTraceEvent
): Promise<void> {
  if (!context.onTraceEvent) {
    return;
  }

  const stampable = event.type === "tool_call" || event.type === "tool_call_start";
  try {
    await context.onTraceEvent(context.executionId && stampable ? {
      ...event,
      executionId: context.executionId
    } : event);
  } catch {
    // Trace sinks must not change tool behavior.
  }
}

function parseJsonText(value: string): unknown {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function toolCallError(message: string): ToolCallOutput {
  return { ok: false, text: message, error: { message } };
}

function builtinCallError(message: string): BuiltinCallError {
  return { ok: false, error: { message } };
}
