import {
  CodeRuntimeTimeoutError,
  CodeModeParseError,
  type CodeRuntime,
  type ExecutionResult,
  type NormalizedCodeRuntimeExecuteInput,
  type ToolInvoker,
  isToolDispatchError,
  errorMessage,
  isAbortError,
  normalizeCodeRuntimeExecuteInput,
  renderCodeModeUserFunctionSource,
  throwIfAborted,
  validateCodeModeUserCode,
  withActiveTimeout,
  type ToolDispatchCode
} from "@cbxss/tack-codemode";
import { transform } from "esbuild";
import {
  newAsyncContext,
  type QuickJSAsyncContext,
  type QuickJSHandle
} from "quickjs-emscripten";
import { randomUUID } from "node:crypto";

import {
  executionErrorCode,
  executionErrorPhase,
  publicExecutionErrorMessage
} from "./error-result.js";
import { normalizeRuntimeOptions, type QuickJSLimits, type QuickJSRuntimeOptions } from "./options.js";
import {
  disposeHandle,
  drainPendingJobs,
  snapshotQuickJSValue,
  toQuickJSJsonValue
} from "./value-bridge.js";

export type { QuickJSRuntimeOptions } from "./options.js";

export function createQuickJSRuntime(options: QuickJSRuntimeOptions = {}): CodeRuntime {
  const limits = normalizeRuntimeOptions(options);

  return {
    name: "quickjs",
    isolation: "vm",
    timeoutMs: limits.timeoutMs,
    toolTimeoutMs: limits.toolTimeoutMs,
    execute: (input, signal = new AbortController().signal) => {
      const normalizedInput = normalizeExecuteInput(input);
      if (!normalizedInput.ok) {
        return Promise.resolve(normalizedInput.result);
      }

      return executeInQuickJS({
        ...normalizedInput.value,
        limits,
        signal
      });
    }
  };
}

interface ExecuteInQuickJSInput {
  readonly code: NormalizedCodeRuntimeExecuteInput["code"];
  readonly invoker: NormalizedCodeRuntimeExecuteInput["invoker"];
  readonly toolsPrelude: NormalizedCodeRuntimeExecuteInput["toolsPrelude"];
  readonly limits: QuickJSLimits;
  readonly signal: AbortSignal;
}

interface RuntimeState {
  readonly context: QuickJSAsyncContext;
  readonly invoker: ToolInvoker;
  readonly emitted: unknown[];
  readonly logs: string[];
  readonly maxToolCalls: number;
  readonly maxToolRequestBytes: number;
  readonly maxToolResponseBytes: number;
  readonly signal: AbortSignal;
  /** Private per-execution capability for a host-originated dispatch error. */
  readonly dispatchToken: string;
  closed: boolean;
  toolCalls: number;
  toolCallsInFlight: number;
}

const normalizeExecuteInput = normalizeCodeRuntimeExecuteInput;

async function executeInQuickJS(input: ExecuteInQuickJSInput): Promise<ExecutionResult> {
  const limits = {
    ...input.limits,
    timeoutMs: Math.max(100, input.limits.timeoutMs)
  };
  const emitted: unknown[] = [];
  const logs: string[] = [];
  let deadlineExceeded = false;
  let state: RuntimeState | undefined;

  try {
    throwIfAborted(input.signal);
    const userFunctionSource = await transpileUserCode({
      code: input.code,
      toolsPrelude: input.toolsPrelude
    });

    const context = await newAsyncContext();
    state = {
      context,
      invoker: input.invoker,
      emitted,
      logs,
      maxToolCalls: limits.maxToolCalls,
      maxToolRequestBytes: limits.maxToolRequestBytes,
      maxToolResponseBytes: limits.maxToolResponseBytes,
      signal: input.signal,
      dispatchToken: randomUUID(),
      closed: false,
      toolCalls: 0,
      toolCallsInFlight: 0
    };
    const runtimeState = state;

    let activeElapsedMs = 0;
    let lastClockSample = Date.now();
    const sampleActiveTime = () => {
      const now = Date.now();
      if (runtimeState.toolCallsInFlight === 0) activeElapsedMs += now - lastClockSample;
      lastClockSample = now;
      return activeElapsedMs;
    };
    context.runtime.setMemoryLimit(limits.memoryMb * 1024 * 1024);
    context.runtime.setMaxStackSize(limits.maxStackBytes);
    context.runtime.setInterruptHandler(() => {
      deadlineExceeded = deadlineExceeded || sampleActiveTime() > limits.timeoutMs;
      return deadlineExceeded || input.signal.aborted;
    });

    const result = await withActiveTimeout({
      promise: runUserFunction(runtimeState, userFunctionSource),
      timeoutMs: limits.timeoutMs,
      signal: input.signal,
      isPaused: () => runtimeState.toolCallsInFlight > 0,
      message: `QuickJS runtime execution timed out after ${limits.timeoutMs}ms`
    });
    return jsonExecutionResult({
      body: {
        ok: true,
        ...(result === undefined ? {} : { result }),
        emitted,
        logs
      },
      maxOutputBytes: limits.maxOutputBytes,
      outputLogs: logs
    });
  } catch (error) {
    if (isAbortError(error, input.signal)) {
      throw error;
    }

    return jsonExecutionResult({
      body: {
        ok: false,
        emitted,
        logs,
        error: {
          phase: executionErrorPhase(error, deadlineExceeded),
          code: executionErrorCode(error, deadlineExceeded, state?.dispatchToken),
          message: publicExecutionErrorMessage(error)
        }
      },
      maxOutputBytes: limits.maxOutputBytes,
      outputLogs: logs
    });
  } finally {
    if (state) {
      state.closed = true;
      state.context.runtime.removeInterruptHandler();
      state.context.dispose();
    }
  }
}

async function runUserFunction(state: RuntimeState, userFunctionSource: string): Promise<unknown> {
  const context = state.context;
  const evalResult = await context.evalCodeAsync(userFunctionSource, "tack-user.js", { type: "global" });
  const functionHandle = context.unwrapResult(evalResult);
  const invokeHandle = context.newFunction("__tackInvoke", (pathHandle, argsHandle) =>
    callToolFromQuickJS(state, pathHandle, argsHandle)
  );
  const consoleHandle = createConsoleHandle(state);
  const emitHandle = context.newFunction("emit", (valueHandle) => {
    state.emitted.push(snapshotQuickJSValue(context, valueHandle));
    return context.undefined;
  });

  let returnHandle: QuickJSHandle | undefined;
  let resolvedHandle: QuickJSHandle | undefined;
  try {
    returnHandle = context.unwrapResult(context.callFunction(
      functionHandle,
      context.undefined,
      [invokeHandle, consoleHandle, emitHandle]
    ));
    drainPendingJobs(context);
    const resolvedPromise = context.resolvePromise(returnHandle);
    drainPendingJobs(context);
    const resolvedResult = await resolvedPromise;
    drainPendingJobs(context);
    resolvedHandle = context.unwrapResult(resolvedResult);
    return snapshotQuickJSValue(context, resolvedHandle);
  } finally {
    disposeHandle(resolvedHandle);
    disposeHandle(returnHandle);
    disposeHandle(emitHandle);
    disposeHandle(consoleHandle);
    disposeHandle(invokeHandle);
    disposeHandle(functionHandle);
  }
}

function callToolFromQuickJS(
  state: RuntimeState,
  pathHandle: QuickJSHandle,
  argsHandle: QuickJSHandle | undefined
): QuickJSHandle {
  const context = state.context;
  const deferred = context.newPromise();
  state.toolCalls += 1;

  if (state.toolCalls > state.maxToolCalls) {
    rejectDeferred(state, deferred, `Exceeded maximum tool calls: ${state.maxToolCalls}`);
    return deferred.handle;
  }

  const path = context.getString(pathHandle);
  const argument = argsHandle ? snapshotQuickJSValue(context, argsHandle) : undefined;
  const args = argument === undefined ? {} : argument;
  const request = { path, args, signal: state.signal };

  try {
    assertJsonByteLimit(request, state.maxToolRequestBytes, "Tool bridge request");
  } catch (error) {
    rejectDeferred(state, deferred, errorMessage(error));
    return deferred.handle;
  }

  state.toolCallsInFlight += 1;
  void Promise.resolve()
    .then(() => state.invoker.invoke(request))
    .then((result) => {
      if (state.closed) {
        return;
      }

      let responseBytes = -1;
      try {
        responseBytes = Buffer.byteLength(JSON.stringify({ ok: true, result }));
      } catch {
        responseBytes = -1;
      }
      if (responseBytes < 0 || responseBytes > state.maxToolResponseBytes) {
        rejectDeferred(
          state,
          deferred,
          responseBytes < 0
            ? "Downstream response is not JSON-serializable."
            : `Downstream call succeeded but its response is ${responseBytes} bytes, over the ${state.maxToolResponseBytes}-byte sandbox limit. Narrow the upstream query — a smaller time window or an added filter — and retry.`,
          "response_too_large"
        );
        return;
      }
      const resultHandle = toQuickJSJsonValue(context, result);
      try {
        deferred.resolve(resultHandle);
      } finally {
        disposeHandle(resultHandle);
      }
    })
    .catch((error) => {
      if (!state.closed) {
        rejectDeferred(
          state,
          deferred,
          errorMessage(error),
          toolDispatchCode(error)
        );
      }
    })
    .finally(() => {
      state.toolCallsInFlight -= 1;
      if (!state.closed) {
        drainPendingJobs(context);
      }
    });

  return deferred.handle;
}

function rejectDeferred(
  state: RuntimeState,
  deferred: ReturnType<QuickJSAsyncContext["newPromise"]>,
  message: string,
  code?: ToolDispatchCode
): void {
  const errorHandle = state.context.newError(message);
  const codeHandle = code ? state.context.newString(code) : undefined;
  const tokenHandle = code ? state.context.newString(state.dispatchToken) : undefined;
  try {
    if (codeHandle) {
      state.context.setProp(errorHandle, "code", codeHandle);
      state.context.setProp(errorHandle, "__tackDispatchToken", tokenHandle!);
    }
    deferred.reject(errorHandle);
  } finally {
    disposeHandle(tokenHandle);
    disposeHandle(codeHandle);
    disposeHandle(errorHandle);
  }
}

function toolDispatchCode(error: unknown): ToolDispatchCode {
  return isToolDispatchError(error) ? error.code : "downstream_error";
}

function createConsoleHandle(state: RuntimeState): QuickJSHandle {
  const context = state.context;
  const consoleHandle = context.newObject();
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const methodHandle = context.newFunction(method, (...args) => {
      state.logs.push(`[${method}] ${args.map((arg) => formatLogArg(snapshotQuickJSValue(context, arg))).join(" ")}`);
      return context.undefined;
    });
    context.setProp(consoleHandle, method, methodHandle);
    methodHandle.dispose();
  }
  return consoleHandle;
}

async function transpileUserCode(input: {
  readonly code: string;
  readonly toolsPrelude: string;
}): Promise<string> {
  try {
    validateCodeModeUserCode(input.code);
    const result = await transform(renderCodeModeUserFunctionSource({
      ...input,
      fetchErrorMessage: "fetch is disabled in Tack QuickJS runtime",
      strict: true
    }), {
      loader: "ts",
      format: "cjs",
      target: "es2022",
      sourcemap: false,
      treeShaking: false
    });
    return result.code;
  } catch (error) {
    throw error instanceof CodeModeParseError ? error : new CodeModeParseError(errorMessage(error));
  }
}

function jsonExecutionResult(input: {
  readonly body: unknown;
  readonly maxOutputBytes: number;
  readonly outputLogs: readonly string[];
}): ExecutionResult {
  let text: string;
  try {
    text = JSON.stringify(input.body);
  } catch (error) {
    return {
      ok: false,
      emitted: [],
      logs: input.outputLogs,
      error: {
        phase: "runtime",
        code: "internal_error",
        message: `Execution output is not JSON serializable: ${errorMessage(error)}`
      }
    };
  }

  if (Buffer.byteLength(text) > input.maxOutputBytes) {
    return {
      ok: false,
      emitted: [],
      logs: input.outputLogs,
      error: {
        phase: "runtime",
        code: "internal_error",
        message: `Execution output exceeded ${input.maxOutputBytes} bytes`
      }
    };
  }

  return JSON.parse(text) as ExecutionResult;
}

function assertJsonByteLimit(value: unknown, maxBytes: number, label: string): void {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maxBytes) {
    throw new Error(`${label} exceeded ${maxBytes} bytes`);
  }
}

function formatLogArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
