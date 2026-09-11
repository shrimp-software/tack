import type { UpstreamOutcome } from "@cbxss/tack-core";
import type { ToolDispatchCode } from "./dispatch-error.js";

export interface ToolInvokeInput {
  readonly path: string;
  readonly args: unknown;
  readonly signal?: AbortSignal | undefined;
}

export interface ToolCallOutput {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly responseId?: string | null;
  /** A compact type-only skeleton of `data` — present on a successful call so a
   *  cell can see the layout without guessing property paths. */
  readonly dataShape?: unknown;
  readonly upstreamOutcome?: UpstreamOutcome;
  readonly error?: {
    readonly code: ToolErrorCode;
    readonly message: string;
  };
}

/** Stable, machine-readable failure kinds exposed to code-mode callers. */
export type ToolErrorCode =
  | "unknown_operation"
  | "operation_denied"
  | "tool_error"
  | ToolDispatchCode
  | "input_validation_failed" | "validation_unavailable" | "output_validation_failed" | "response_persistence_failed"
  | "internal_error";

export interface ToolInvoker {
  invoke(input: ToolInvokeInput): Promise<unknown>;
}

export type ExecuteErrorPhase = "parse" | "typecheck" | "runtime" | "timeout";

export interface ExecuteError {
  readonly phase: ExecuteErrorPhase;
  readonly code: ExecuteErrorCode;
  readonly message: string;
}

export type ExecuteErrorCode =
  | ToolErrorCode
  | "parse_error"
  | "typecheck_error"
  | "execution_timeout";

export interface ExecutionResult {
  readonly receiptId?: string | undefined;
  readonly responseId?: string | undefined;
  readonly executionId?: string | undefined;
  readonly ok: boolean;
  readonly result?: unknown;
  /** Set when `result` was clipped to fit the model/wire budget. */
  readonly resultTruncated?: boolean | undefined;
  readonly emitted: readonly unknown[];
  readonly logs: readonly string[];
  readonly trace?: ExecutionTrace | undefined;
  readonly error?: ExecuteError;
  /**
   * TypeScript diagnostics from the pre-run typecheck. Present when the checker
   * found something: on a blocked result (`error.phase === "typecheck"`, nothing
   * ran) or alongside a normal result in `warn` mode.
   */
  readonly typeDiagnostics?: readonly TypeDiagnostic[] | undefined;
}

/** One TypeScript diagnostic, positioned in the model's original cell source. */
export interface TypeDiagnostic {
  /** 1-based line in the submitted code. */
  readonly line: number;
  /** 1-based column. */
  readonly column: number;
  /** e.g. `"TS2551"`. */
  readonly code: string;
  readonly message: string;
  readonly category: "error" | "warning";
}

export interface TypeCheckOutcome {
  readonly diagnostics: readonly TypeDiagnostic[];
  /** True when the checker could not run (e.g. its language service threw). The
   *  engine proceeds with execution — a checker fault never blocks a run. */
  readonly skipped?: boolean | undefined;
  readonly skipReason?: string | undefined;
}

/**
 * Pre-run typechecker for code-mode cells. Implemented by `@cbxss/tack-typecheck` and
 * injected into `createExecutionEngine`; `@cbxss/tack-codemode` never imports it.
 */
export interface TypeChecker {
  check(code: string): Promise<TypeCheckOutcome>;
}

export interface ExecutionTrace {
  readonly runtime: string;
  readonly isolation: CodeRuntime["isolation"];
  readonly startedAt: string;
  readonly durationMs: number;
  readonly toolCalls: number;
  readonly deniedToolCalls: number;
  readonly failedToolCalls: number;
  readonly builtinCalls: readonly BuiltinTraceEvent[];
  readonly operations: readonly OperationTraceEvent[];
}

export interface BuiltinTraceEvent {
  readonly type: "builtin_call";
  readonly path: "search" | "describe.tool" | "guidance.read";
  readonly ok: boolean;
  readonly durationMs: number;
  readonly error?: string | undefined;
}

/**
 * Emitted the moment an operation call begins, before it is awaited, so a live
 * trace can show a call in flight. Carries operation identity and timing only —
 * never arguments — matching the {@link OperationTraceEvent} contract.
 */
export interface OperationStartTraceEvent {
  readonly type: "tool_call_start";
  readonly timestamp: string;
  readonly executionId?: string | undefined;
  readonly path: string;
  readonly toolId?: string | undefined;
}

export interface OperationTraceEvent {
  readonly upstreamOutcome?: UpstreamOutcome | undefined;
  readonly type: "tool_call";
  readonly timestamp: string;
  readonly executionId?: string | undefined;
  readonly path: string;
  readonly toolId?: string | undefined;
  readonly allowed: boolean;
  readonly ok?: boolean | undefined;
  readonly durationMs?: number | undefined;
  readonly error?: string | undefined;
}

export type ToolTraceEvent = BuiltinTraceEvent | OperationStartTraceEvent | OperationTraceEvent;

/** Sink for live trace events as an execution runs. Must be fast and must not throw. */
export type TraceSink = (event: ToolTraceEvent) => void;

export interface CodeRuntimeExecuteInput {
  readonly code: string;
  readonly invoker: ToolInvoker;
  readonly toolsPrelude: string;
}

export interface CodeRuntime {
  readonly name: string;
  readonly isolation: "none" | "vm" | "process";
  readonly timeoutMs?: number;
  readonly toolTimeoutMs?: number;
  execute(input: CodeRuntimeExecuteInput, signal?: AbortSignal): Promise<ExecutionResult>;
}
