import { BUILTIN_CONTRACTS, type BuiltinName } from "@cbxss/tack-core";
import { invokeBuiltin } from "./discovery.js";
import { ValidationKernel, type ValidationResult } from "@cbxss/tack-validation";
import { ExecutionHost, operationOrigin, catalogRevision } from "./host.js";
import { describeShape } from "./data-shape.js";
import { findGuide } from "./guide.js";
import {
  findOperation,
  snapshotManifest,
  operationArgs,
  ownField,
  type TackManifest,
  type TackRuntime
} from "@cbxss/tack-core";

import { describeTool, normalizeDescribeToolInput } from "./describe.js";
import { ToolDispatchError } from "./dispatch-error.js";
import { isOperationAllowed, type OperationPolicy } from "./policy.js";
import { CodeRuntimeTimeoutError, errorMessage, withTimeout } from "./runtime-lifecycle.js";
import { attachTypeScript, listNamespaces, normalizeSearchInput, searchOperations } from "./search.js";
import type { BuiltinTraceEvent, ToolCallOutput, ToolInvoker, ToolTraceEvent } from "./types.js";

export interface CreateTackToolInvokerOptions {
  readonly host?: ExecutionHost | undefined;
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly policy?: OperationPolicy | undefined;
  readonly executionId?: string | undefined;
  readonly toolTimeoutMs?: number | undefined;
  readonly onTraceEvent?: ((event: ToolTraceEvent) => void | Promise<void>) | undefined;
  readonly onAuditEvent?: ((event: ToolAuditEvent) => void | Promise<void>) | undefined;
  readonly responseOwner?: string | undefined;
}

export type ToolAuditEvent = Extract<ToolTraceEvent, { readonly type: "tool_call" }>;

interface BuiltinCallError {
  readonly ok: false;
  readonly error: {
    readonly code: "internal_error";
    readonly message: string;
  };
}

interface ToolInvokerContext {
  readonly host?: ExecutionHost | undefined;
  readonly validator: ValidationKernel;
  readonly responseOwner: string;
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly policy?: OperationPolicy | undefined;
  readonly executionId?: string | undefined;
  readonly toolTimeoutMs?: number | undefined;
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
      if (Object.hasOwn(BUILTIN_CONTRACTS, path)) {
        return traceBuiltin(context, path as BuiltinName, () => invokeBuiltin(path as BuiltinName, args, context, ownField<AbortSignal>(input, "signal")));
      }

      return invokeOperation(context, path, args, ownField<AbortSignal>(input, "signal"));
    }
  };
}

function normalizeToolInvokerContext(options: CreateTackToolInvokerOptions): ToolInvokerContext {
  const policy = ownField<OperationPolicy>(options, "policy");
  const executionId = ownField<string>(options, "executionId");
  const onTraceEvent = ownField<CreateTackToolInvokerOptions["onTraceEvent"]>(options, "onTraceEvent");
  const onAuditEvent = ownField<CreateTackToolInvokerOptions["onAuditEvent"]>(options, "onAuditEvent");
  return {
    host: ownField<ExecutionHost>(options, "host"),
    validator: new ValidationKernel(),
    responseOwner: ownField<string>(options, "responseOwner") ?? "local",
    manifest: snapshotManifest(ownField<TackManifest>(options, "manifest") as TackManifest),
    runtime: ownField<TackRuntime>(options, "runtime") as TackRuntime,
    ...(policy ? { policy } : {}),
    ...(executionId ? { executionId } : {}),
    ...(typeof ownField<number>(options, "toolTimeoutMs") === "number" ? { toolTimeoutMs: ownField<number>(options, "toolTimeoutMs") } : {}),
    ...(onTraceEvent ? { onTraceEvent } : {}),
    ...(onAuditEvent ? { onAuditEvent } : {})
  };
}

async function traceBuiltin<T>(
  context: ToolInvokerContext,
  path: BuiltinTraceEvent["path"],
  run: () => T | Promise<T>
): Promise<T | BuiltinCallError | (BuiltinCallError & { revision: string; items: never[]; total: number; hasMore: boolean; nextOffset: null })> {
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
    const message = errorMessage(error).slice(0, 1500);
    await emitTrace(context, {
      type: "builtin_call",
      path,
      ok: false,
      durationMs: Date.now() - started,
      error: message
    });
    if (path === "search") return { ...builtinCallError(message), revision: catalogRevision(context.manifest), items: [], total: 0, hasMore: false, nextOffset: null };
    return builtinCallError(message);
  }
}

async function invokeOperation(
  context: ToolInvokerContext,
  path: string,
  args: unknown,
  signal: AbortSignal | undefined
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
    return toolCallError("unknown_operation", `Unknown Tack operation: ${path}`);
  }

  const decision = isOperationAllowed(operation, context.policy);
  if (!decision.allowed || (context.host && !context.host.canInvoke(context.responseOwner, operation, manifest))) {
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
    return toolCallError("operation_denied", decision.reason ?? `Operation denied by current policy or source binding: ${operation.fullPathString}`);
  }

  await emitTrace(context, {
    type: "tool_call_start",
    timestamp: new Date().toISOString(),
    path: operation.fullPathString,
    toolId: operation.toolId
  });

  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  }

  let upstreamStarted = false;
  try {
    const job = { purpose: "input" as const, schema: operation.inputSchema, value: args };
    const checked = context.host ? await context.host.validate(context.responseOwner, job, controller.signal) : context.validator.validate(job);
    if (checked.status !== "passed" && checked.status !== "partial") {
      await emitAudit(context, { type: "tool_call", timestamp: new Date().toISOString(), path, toolId: operation.toolId, allowed: true, ok: false, durationMs: Date.now() - started, upstreamOutcome: "not_started", error: "Input validation failed" });
      return { ok: false, upstreamOutcome: "not_started", error: { code: checked.status === "failed" ? "input_validation_failed" : "validation_unavailable", message: checked.diagnostics.slice(0, 3).map(d => `${operation.fullPathString}${d.pointer ?? ""}: ${d.message}`).join("; ").slice(0, 1500) } };
    }
    controller.signal.throwIfAborted();
    if (context.host && !context.host.canInvoke(context.responseOwner, operation, manifest)) return toolCallError("operation_denied", "Operation revoked before dispatch");
    upstreamStarted = true;
    const invoke = context.runtime.invoke(operation.toolId, operationArgs(operation, args), { signal: controller.signal });
    const result = context.toolTimeoutMs === undefined ? await invoke : await withTimeout({
      promise: invoke,
      timeoutMs: context.toolTimeoutMs,
      signal: controller.signal,
      message: `Tool call timed out after ${context.toolTimeoutMs}ms`
    });
    const text = result.text();
    const parsed = result.structuredContent === undefined ? parseJsonText(text) : result.structuredContent;
    const data = parsed === undefined ? text : parsed;
    let outputValidation: ValidationResult | undefined;
    if (!result.isError && operation.outputSchema) {
      try { outputValidation = context.host ? await context.host.validate(context.responseOwner, { purpose: "output", schema: operation.outputSchema, value: data }, controller.signal) : context.validator.validate({ purpose: "output", schema: operation.outputSchema, value: data }); }
      catch (error) { outputValidation = { status: "unavailable", validator: "none", coverage: { assertions: "not_performed", schemaSupport: "unknown", localRefs: false, remoteRefs: false, formatAssertions: false }, diagnostics: [{ code: "output_validation_unavailable", message: errorMessage(error) }] }; }
    }
    let response;
    let retentionError: string | undefined;
    if (context.host) {
      try { response = await context.host.retain(context.responseOwner, data, {
        origins: [operationOrigin(operation, manifest)], executionId: context.executionId, raw: result.raw, text,
        upstreamOutcome: result.isError ? "failed" : "succeeded", evidence: { inputValidation: checked, args: args ?? {}, operation: operation.fullPathString, outputValidation: outputValidation ?? null }
      }); } catch (error) {
        // Retention is an audit-evidence concern, not a delivery concern: a
        // successful upstream call still returns its data. Never replay a write.
        retentionError = `response retention failed; evidence not persisted. ${errorMessage(error)}`;
      }
    }
    const responseId = response?.id ?? null;
    if (context.host && !context.host.canInvoke(context.responseOwner, operation, manifest)) {
      return { ok: false, upstreamOutcome: result.isError ? "failed" : "succeeded", error: { code: "operation_denied", message: "Origin authorization changed during the upstream call. Evidence retained under current policy; do not replay automatically." } };
    }
    if (result.isError || (outputValidation && outputValidation.status !== "passed" && outputValidation.status !== "partial")) {
      await emitAudit(context, {
        type: "tool_call",
        timestamp: new Date().toISOString(),
        path: operation.fullPathString,
        toolId: operation.toolId,
        allowed: true,
        ok: false,
        upstreamOutcome: result.isError ? "failed" : "succeeded",
        durationMs: Date.now() - started,
        error: text || `Tool returned an error: ${operation.fullPathString}`
      });
      return {
        ok: false,
        responseId,
        upstreamOutcome: result.isError ? "failed" : "succeeded",
        error: { code: result.isError ? "tool_error" : "output_validation_failed", message: result.isError ? (text || `Tool returned an error: ${operation.fullPathString}`).slice(0, 1500) : "Upstream succeeded but output validation failed or was unavailable. Inspect the response; do not replay automatically." }
      };
    }

    await emitAudit(context, {
      type: "tool_call",
      timestamp: new Date().toISOString(),
      path: operation.fullPathString,
      toolId: operation.toolId,
      allowed: true,
      ok: true,
      upstreamOutcome: "succeeded",
      durationMs: Date.now() - started,
      ...(retentionError ? { error: retentionError } : {})
    });
    return {
      ok: true,
      data,
      responseId,
      dataShape: describeShape(data),
      upstreamOutcome: "succeeded"
    };
  } catch (error) {
    if (error instanceof CodeRuntimeTimeoutError) {
      controller.abort(error);
    }
    const message = `${upstreamStarted ? "Upstream outcome unknown; do not replay automatically. " : "Upstream not started. "}${errorMessage(error)}` || `Failed to call ${operation.fullPathString}`;
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
    // A rejected runtime call means the downstream transport/protocol failed,
    // rather than a tool returning a valid MCP `isError` result. Let the code
    // runtime reject here so `execute` finishes with that error immediately.
    throw new ToolDispatchError(
      error instanceof CodeRuntimeTimeoutError
        ? "tool_timeout"
        : controller.signal.aborted && signal?.aborted
          ? "cancelled"
          : "downstream_error",
      message,
      error
    );
  } finally {
    signal?.removeEventListener("abort", abort);
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

function toolCallError(
  code: "unknown_operation" | "operation_denied",
  message: string
): ToolCallOutput {
  return { ok: false, upstreamOutcome: "not_started", error: { code, message } };
}

function builtinCallError(message: string): BuiltinCallError {
  return { ok: false, error: { code: "internal_error", message } };
}
