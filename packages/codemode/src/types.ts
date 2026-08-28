export interface ToolInvokeInput {
  readonly path: string;
  readonly args: unknown;
}

export interface ToolCallOutput {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly text: string;
  readonly raw?: unknown;
  readonly error?: {
    readonly message: string;
  };
}

export interface ToolInvoker {
  invoke(input: ToolInvokeInput): Promise<unknown>;
}

export type ExecuteErrorPhase = "parse" | "runtime" | "timeout";

export interface ExecuteError {
  readonly phase: ExecuteErrorPhase;
  readonly message: string;
}

export interface ExecutionResult {
  readonly executionId?: string | undefined;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly emitted: readonly unknown[];
  readonly logs: readonly string[];
  readonly trace?: ExecutionTrace | undefined;
  readonly error?: ExecuteError;
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
  readonly path: "search" | "describe.tool";
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

/**
 * A long-lived runtime context. Successive {@link CodeSession.exec} calls share
 * one scope — top-level `const`/`let`/`function`/`class` from one cell are
 * visible to the next — until {@link CodeSession.close}.
 */
export interface CodeSession {
  exec(input: CodeRuntimeExecuteInput, signal?: AbortSignal): Promise<ExecutionResult>;
  close(): Promise<void>;
}

export interface CodeSessionOptions {
  /** Wall-clock budget across all cells; the session rejects `exec` once exceeded. */
  readonly maxLifetimeMs?: number;
}

export interface CodeRuntime {
  readonly name: string;
  readonly isolation: "none" | "vm" | "process";
  readonly timeoutMs?: number;
  execute(input: CodeRuntimeExecuteInput, signal?: AbortSignal): Promise<ExecutionResult>;
  /** Present only on runtimes that support stateful sessions (QuickJS). */
  createSession?(options?: CodeSessionOptions): Promise<CodeSession>;
}
