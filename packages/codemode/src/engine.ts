import { randomUUID } from "node:crypto";
import {
  listOperations,
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
  CodeSession,
  CodeSessionOptions,
  DerefOptions,
  DerefResult,
  ExecutionResult,
  ExecutionTrace,
  TypeChecker,
  TypeDiagnostic,
  ToolTraceEvent,
  TraceSink
} from "./types.js";

/** Typecheck posture: block on diagnostics, attach-but-run, or skip entirely. */
export type TypecheckMode = "error" | "warn" | "off";

export interface CreateExecutionEngineOptions {
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly codeRuntime: CodeRuntime;
  readonly policy?: OperationPolicy | undefined;
  readonly onAuditEvent?: Parameters<typeof createTackToolInvoker>[0]["onAuditEvent"];
  /** Live trace sink — receives every tool/builtin event as the execution runs. */
  readonly onTrace?: TraceSink | undefined;
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

/** A stateful code-mode session: `exec` cells share one persistent scope. */
export interface ExecutionSession {
  readonly id: string;
  exec(code: string, options?: ExecuteOptions): Promise<ExecutionResult>;
  /** Retrieve a value an earlier cell retained as a ref. Never rejects. */
  deref(ref: string, options?: DerefOptions): Promise<DerefResult>;
  /** Names in scope from earlier cells (bindings + `$N`/`$_` refs). */
  scope(): { readonly names: readonly string[] };
  close(): Promise<void>;
}

export interface ExecutionEngine {
  getDescription(): string;
  execute(code: string, options?: ExecuteOptions): Promise<ExecutionResult>;
  /** Whether the underlying runtime supports {@link ExecutionEngine.createSession}. */
  readonly supportsSessions: boolean;
  createSession(options?: CodeSessionOptions): Promise<ExecutionSession>;
}

export function createExecutionEngine(
  options: CreateExecutionEngineOptions
): ExecutionEngine {
  const manifest = ownField(options, "manifest") as TackManifest;
  const runtime = ownField(options, "runtime") as TackRuntime;
  const codeRuntime = normalizeCodeRuntime(ownField(options, "codeRuntime") as CodeRuntime);
  const policy = ownField(options, "policy") as OperationPolicy | undefined;
  const onAuditEvent = ownField(options, "onAuditEvent") as CreateExecutionEngineOptions["onAuditEvent"];
  const defaultOnTrace = ownField(options, "onTrace") as TraceSink | undefined;
  const typecheck = ownField(options, "typecheck") as CreateExecutionEngineOptions["typecheck"];

  const toolsPrelude = renderToolsPrelude(
    filterAllowedOperations(listOperations(manifest), policy).map((operation) => operation.fullPathString)
  );

  const runCell = async (
    run: (input: CodeRuntimeExecuteInput, signal?: AbortSignal) => Promise<ExecutionResult>,
    code: string,
    cellOptions: ExecuteOptions | undefined,
    scopeNames?: readonly string[]
  ): Promise<ExecutionResult> => {
    const onTrace = cellOptions?.onTrace ?? defaultOnTrace;
    const executionId = randomUUID();
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const traceEvents: ToolTraceEvent[] = [];

    // Pre-run typecheck. `error` blocks (nothing upstream fires); `warn` attaches
    // diagnostics and continues; a checker that skips is treated as absent.
    const mode = cellOptions?.typecheck ?? typecheck?.mode;
    let typeDiagnostics: readonly TypeDiagnostic[] | undefined;
    if (typecheck?.checker && mode && mode !== "off") {
      const outcome = await typecheck.checker.check(
        code,
        scopeNames && scopeNames.length > 0 ? { scopeNames } : undefined
      );
      if (!outcome.skipped && outcome.diagnostics.length > 0) {
        if (mode === "error") {
          return {
            executionId,
            ok: false,
            emitted: [],
            logs: [],
            error: { phase: "typecheck", code: "typecheck_error", message: formatTypeDiagnostics(outcome.diagnostics) },
            typeDiagnostics: outcome.diagnostics,
            trace: summarizeTrace({ runtime: codeRuntime, startedAt, startedAtMs, events: [] })
          };
        }
        typeDiagnostics = outcome.diagnostics;
      }
    }

    const invoker = createTackToolInvoker({
      manifest,
      runtime,
      executionId,
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

    const result = await run(
      { code, invoker, toolsPrelude },
      cellOptions?.signal
    );
    return {
      ...result,
      executionId,
      trace: summarizeTrace({ runtime: codeRuntime, startedAt, startedAtMs, events: traceEvents }),
      ...(typeDiagnostics ? { typeDiagnostics } : {})
    };
  };

  return {
    getDescription: () => createExecuteDescription(manifest, policy),
    supportsSessions: typeof codeRuntime.createSession === "function",
    execute: (code, cellOptions) =>
      runCell((input, sig) => codeRuntime.execute(input, sig), code, cellOptions),
    createSession: async (sessionOptions) => {
      if (typeof codeRuntime.createSession !== "function") {
        throw new Error(`Runtime "${codeRuntime.name}" does not support sessions`);
      }
      const codeSession = await codeRuntime.createSession(sessionOptions);
      const id = `s_${randomUUID()}`;
      const scope = (): { readonly names: readonly string[] } =>
        typeof codeSession.scope === "function" ? codeSession.scope() : { names: [] };
      return {
        id,
        exec: (code, cellOptions) =>
          runCell((input, sig) => codeSession.exec(input, sig), code, cellOptions, scope().names),
        deref: (ref, derefOptions): Promise<DerefResult> =>
          typeof codeSession.deref === "function"
            ? codeSession.deref(ref, derefOptions)
            : Promise.resolve({ ok: false, error: "This runtime does not support deref" }),
        scope,
        close: () => codeSession.close()
      };
    }
  };
}

function normalizeCodeRuntime(runtime: CodeRuntime): CodeRuntime {
  const name = ownField(runtime, "name");
  const isolation = ownField(runtime, "isolation");
  const timeoutMs = ownField(runtime, "timeoutMs");
  const toolTimeoutMs = ownField(runtime, "toolTimeoutMs");
  const execute = ownField(runtime, "execute");
  const createSession = ownField(runtime, "createSession");
  if (typeof execute !== "function") {
    throw new TypeError("Code runtime execute is required");
  }

  return {
    name: typeof name === "string" ? name : "unknown",
    isolation: isolation === "process" || isolation === "vm" ? isolation : "none",
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    ...(typeof toolTimeoutMs === "number" ? { toolTimeoutMs } : {}),
    execute: (input, signal) => execute.call(runtime, input, signal) as ReturnType<CodeRuntime["execute"]>,
    ...(typeof createSession === "function"
      ? {
          createSession: (sessionOptions?: CodeSessionOptions): Promise<CodeSession> =>
            createSession.call(runtime, sessionOptions) as Promise<CodeSession>
        }
      : {})
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
