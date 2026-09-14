import { assertToolNamespaces } from "./discovery.js";
import { ExecutionHost } from "./host.js";
import { randomUUID } from "node:crypto";
import {
  listOperations,
  snapshotManifest,
  ownField,
  type TackManifest,
  type TackRuntime
} from "@cbxss/tack-core";

import { createTackToolInvoker } from "./invoker.js";
import { createExecuteDescription } from "./guide.js";
import { filterAllowedOperations } from "./policy.js";
import type { OperationPolicy } from "./policy.js";
import { renderToolsPrelude } from "./tools.js";
import { formatTypeDiagnostics } from "./type-diagnostics.js";
import type {
  CodeRuntime,
  CodeRuntimeExecuteInput,
  ExecutionResult,
  ExecutionTrace,
  TypeChecker,
  TypeDiagnostic,
  ToolTraceEvent,
  TraceSink
} from "./types.js";

/** Typecheck posture: block on diagnostics, attach-but-run, or skip entirely. */
export type TypecheckMode = "strict" | "error" | "warn" | "off";

export interface CreateExecutionEngineOptions {
  readonly host?: ExecutionHost | undefined;
  readonly responseOwner?: string | undefined;
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly codeRuntime: CodeRuntime;
  readonly policy?: OperationPolicy | undefined;
  readonly onAuditEvent?: Parameters<typeof createTackToolInvoker>[0]["onAuditEvent"];
  /** Live trace sink — receives every tool/builtin event as the execution runs. */
  readonly onTrace?: TraceSink | undefined;
  /** Forwarded to {@link createTackToolInvoker}; see `normalizeWhitespace` there. */
  readonly normalizeWhitespace?: readonly string[] | undefined;
  /**
   * Pre-run typecheck. When set, every cell is checked before it executes;
   * `mode: "error"` blocks on any diagnostic (nothing upstream fires),
   * `mode: "warn"` attaches diagnostics and runs anyway. A per-call
   * {@link ExecuteOptions.typecheck} overrides the mode.
   */
  readonly typecheck?: { readonly checker: TypeChecker; readonly mode: "error" | "warn" } | undefined;
}

export interface ExecuteOptions {
  readonly onTrace?: TraceSink | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Override the engine's typecheck mode for this cell. */
  readonly typecheck?: TypecheckMode | undefined;
}

export interface ExecutionEngine {
  close(): Promise<void>;
  getDescription(): string;
  execute(code: string, options?: ExecuteOptions): Promise<ExecutionResult>;
}

export function createExecutionEngine(
  options: CreateExecutionEngineOptions
): ExecutionEngine {
  const manifest = snapshotManifest(ownField(options, "manifest") as TackManifest);
  assertToolNamespaces(manifest);
  const runtime = ownField(options, "runtime") as TackRuntime;
  const codeRuntime = normalizeCodeRuntime(ownField(options, "codeRuntime") as CodeRuntime);
  const policy = ownField(options, "policy") as OperationPolicy | undefined;
  const onAuditEvent = ownField(options, "onAuditEvent") as CreateExecutionEngineOptions["onAuditEvent"];
  const defaultOnTrace = ownField(options, "onTrace") as TraceSink | undefined;
  const typecheck = ownField(options, "typecheck") as CreateExecutionEngineOptions["typecheck"];
  const responseOwner = ownField<string>(options, "responseOwner") ?? "local";
  const normalizeWhitespace = ownField<readonly string[]>(options, "normalizeWhitespace");

  const suppliedHost = ownField<ExecutionHost>(options, "host");
  const host = suppliedHost ?? new ExecutionHost();
  host.authorize(responseOwner, manifest, policy);
  const toolsPrelude = renderToolsPrelude(
    filterAllowedOperations(listOperations(manifest), policy).map((operation) => operation.fullPathString)
  );

  const runCell = async (
    run: (input: CodeRuntimeExecuteInput, signal?: AbortSignal) => Promise<ExecutionResult>,
    code: string,
    cellOptions: ExecuteOptions | undefined
  ): Promise<ExecutionResult> => {
    const onTrace = cellOptions?.onTrace ?? defaultOnTrace;
    const executionId = randomUUID();
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const traceEvents: ToolTraceEvent[] = [];

    host.begin(executionId);
    // Pre-run typecheck. `error` blocks (nothing upstream fires); `warn` attaches
    // diagnostics and continues; a checker that skips is treated as absent.
    const mode = cellOptions?.typecheck ?? "off";
    let typeDiagnostics: readonly TypeDiagnostic[] | undefined;
    if ((mode === "strict" || mode === "error") && !typecheck?.checker) {
      return host.finish(responseOwner, code, { executionId, ok: false, logs: [], emitted: [], error: { phase: "typecheck", code: "typecheck_error", message: "Strict typechecking is unavailable; no upstream calls started." } }, manifest);
    }
    if (typecheck?.checker && mode !== "off") {
      const outcome = await typecheck.checker.check(code);
      if (outcome.skipped && (mode === "strict" || mode === "error")) {
        return host.finish(responseOwner, code, { executionId, ok: false, logs: [], emitted: [], error: { phase: "typecheck", code: "typecheck_error", message: "Strict typechecking was skipped; no upstream calls started." } }, manifest);
      }
      if (!outcome.skipped && outcome.diagnostics.length > 0) {
        if (mode === "error" || mode === "strict") {
          return host.finish(responseOwner, code, {
            executionId,
            ok: false,
            emitted: [],
            logs: [],
            error: { phase: "typecheck", code: "typecheck_error", message: formatTypeDiagnostics(outcome.diagnostics) },
            typeDiagnostics: outcome.diagnostics,
            trace: summarizeTrace({ runtime: codeRuntime, startedAt, startedAtMs, events: [] })
          }, manifest);
        }
        typeDiagnostics = outcome.diagnostics;
      }
    }

    const invoker = createTackToolInvoker({
      host,
      manifest,
      runtime,
      responseOwner,
      executionId,
      ...(normalizeWhitespace ? { normalizeWhitespace } : {}),
      ...(typeof codeRuntime.toolTimeoutMs === "number" ? { toolTimeoutMs: codeRuntime.toolTimeoutMs } : {}),
      ...(policy ? { policy } : {}),
      onTraceEvent: (event) => {
        traceEvents.push(event);
        if (onTrace) {
          queueMicrotask(() => onTrace(event));
        }
      },
      ...(onAuditEvent ? { onAuditEvent } : {})
    });

    let result: ExecutionResult;
    try { result = await run({ code, invoker, toolsPrelude }, cellOptions?.signal); }
    catch (error) { result = { ok: false, logs: [], emitted: [], error: { phase: "runtime", code: "internal_error", message: `Execution failed; do not automatically replay tool calls. ${error instanceof Error ? error.message : "Runtime error"}` } }; }
    return host.finish(responseOwner, code, {
      ...result,
      executionId,
      trace: summarizeTrace({ runtime: codeRuntime, startedAt, startedAtMs, events: traceEvents }),
      ...(typeDiagnostics ? { typeDiagnostics } : {})
    }, manifest);
  };

  return {
    close: () => suppliedHost ? Promise.resolve() : host.close(),
    getDescription: () => createExecuteDescription(manifest, policy),
    execute: (code, cellOptions) =>
      runCell((input, sig) => codeRuntime.execute(input, sig), code, cellOptions)
  };
}

function normalizeCodeRuntime(runtime: CodeRuntime): CodeRuntime {
  const name = ownField(runtime, "name");
  const isolation = ownField(runtime, "isolation");
  const timeoutMs = ownField(runtime, "timeoutMs");
  const toolTimeoutMs = ownField(runtime, "toolTimeoutMs");
  const execute = ownField(runtime, "execute");
  if (typeof execute !== "function") {
    throw new TypeError("Code runtime execute is required");
  }

  return {
    name: typeof name === "string" ? name : "unknown",
    isolation: isolation === "process" || isolation === "vm" ? isolation : "none",
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    ...(typeof toolTimeoutMs === "number" ? { toolTimeoutMs } : {}),
    execute: (input, signal) => execute.call(runtime, input, signal) as ReturnType<CodeRuntime["execute"]>
  };
}

function summarizeTrace(input: {
  readonly runtime: CodeRuntime;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly events: readonly ToolTraceEvent[];
}): ExecutionTrace {
  const operations = input.events.filter((event) => event.type === "tool_call");
  return {
    runtime: input.runtime.name,
    isolation: input.runtime.isolation,
    startedAt: input.startedAt,
    durationMs: Date.now() - input.startedAtMs,
    toolCalls: operations.length,
    deniedToolCalls: operations.filter((event) => !event.allowed).length,
    failedToolCalls: operations.filter((event) => event.ok === false).length,
    builtinCalls: input.events.filter((event) => event.type === "builtin_call"),
    operations
  };
}
