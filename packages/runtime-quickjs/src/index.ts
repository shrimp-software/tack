import {
  CodeRuntimeTimeoutError,
  CodeModeParseError,
  type CodeRuntime,
  type CodeSession,
  type CodeSessionOptions,
  type DerefResult,
  type ExecuteErrorPhase,
  type ExecutionResult,
  type NormalizedCodeRuntimeExecuteInput,
  type ToolInvoker,
  errorMessage,
  isAbortError,
  normalizeCodeRuntimeExecuteInput,
  renderCodeModeUserFunctionSource,
  throwIfAborted,
  validateCodeModeUserCode,
  withTimeout
} from "@tack/codemode";
import { ownDataValue } from "@tack/core";
import { transform } from "esbuild";
import {
  newAsyncContext,
  type QuickJSAsyncContext,
  type QuickJSHandle
} from "quickjs-emscripten";

import { rewriteCellScope } from "./scope-rewrite.js";

export interface QuickJSRuntimeOptions {
  readonly timeoutMs?: number;
  readonly memoryMb?: number;
  readonly maxStackBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxToolCalls?: number;
  readonly maxToolRequestBytes?: number;
  readonly maxToolResponseBytes?: number;
  /** In a session, a returned/emitted value larger than this is retained as a ref. */
  readonly maxInlineResultBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_MB = 128;
const DEFAULT_MAX_STACK_BYTES = 1_000_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_MAX_TOOL_CALLS = 100;
const DEFAULT_MAX_TOOL_REQUEST_BYTES = 1_000_000;
const DEFAULT_MAX_TOOL_RESPONSE_BYTES = 1_000_000;
const DEFAULT_MAX_INLINE_RESULT_BYTES = 4_096;
const REF_PREVIEW_LIMIT = 10;
const DEREF_DEFAULT_LIMIT = 100;

export function createQuickJSRuntime(options: QuickJSRuntimeOptions = {}): CodeRuntime {
  const limits = normalizeRuntimeOptions(options);

  return {
    name: "quickjs",
    isolation: "vm",
    timeoutMs: limits.timeoutMs,
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
    },
    createSession: (sessionOptions) => createQuickJSSession(limits, sessionOptions)
  };
}

interface ExecuteInQuickJSInput {
  readonly code: NormalizedCodeRuntimeExecuteInput["code"];
  readonly invoker: NormalizedCodeRuntimeExecuteInput["invoker"];
  readonly toolsPrelude: NormalizedCodeRuntimeExecuteInput["toolsPrelude"];
  readonly limits: QuickJSLimits;
  readonly signal: AbortSignal;
}

interface QuickJSLimits {
  readonly timeoutMs: number;
  readonly memoryMb: number;
  readonly maxStackBytes: number;
  readonly maxOutputBytes: number;
  readonly maxToolCalls: number;
  readonly maxToolRequestBytes: number;
  readonly maxToolResponseBytes: number;
  readonly maxInlineResultBytes: number;
}

interface RuntimeState {
  readonly context: QuickJSAsyncContext;
  readonly invoker: ToolInvoker;
  readonly emitted: unknown[];
  readonly logs: string[];
  readonly maxToolCalls: number;
  readonly maxToolRequestBytes: number;
  readonly maxToolResponseBytes: number;
  closed: boolean;
  toolCalls: number;
}

function normalizeRuntimeOptions(options: QuickJSRuntimeOptions): QuickJSLimits {
  return {
    timeoutMs: readOwnNumber(options, "timeoutMs") ?? DEFAULT_TIMEOUT_MS,
    memoryMb: readOwnNumber(options, "memoryMb") ?? DEFAULT_MEMORY_MB,
    maxStackBytes: readOwnNumber(options, "maxStackBytes") ?? DEFAULT_MAX_STACK_BYTES,
    maxOutputBytes: readOwnNumber(options, "maxOutputBytes") ?? DEFAULT_MAX_OUTPUT_BYTES,
    maxToolCalls: readOwnNumber(options, "maxToolCalls") ?? DEFAULT_MAX_TOOL_CALLS,
    maxToolRequestBytes: readOwnNumber(options, "maxToolRequestBytes") ?? DEFAULT_MAX_TOOL_REQUEST_BYTES,
    maxToolResponseBytes: readOwnNumber(options, "maxToolResponseBytes") ?? DEFAULT_MAX_TOOL_RESPONSE_BYTES,
    maxInlineResultBytes: readOwnNumber(options, "maxInlineResultBytes") ?? DEFAULT_MAX_INLINE_RESULT_BYTES
  };
}

const normalizeExecuteInput = normalizeCodeRuntimeExecuteInput;

function readOwnNumber(
  options: QuickJSRuntimeOptions,
  key: keyof QuickJSRuntimeOptions
): number | undefined {
  const value = ownDataValue(options, key);
  return typeof value === "number" ? value : undefined;
}

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
      closed: false,
      toolCalls: 0
    };

    const deadline = Date.now() + limits.timeoutMs;
    context.runtime.setMemoryLimit(limits.memoryMb * 1024 * 1024);
    context.runtime.setMaxStackSize(limits.maxStackBytes);
    context.runtime.setInterruptHandler(() => {
      deadlineExceeded = deadlineExceeded || Date.now() > deadline;
      return deadlineExceeded || input.signal.aborted;
    });

    const result = await withTimeout({
      promise: runUserFunction(state, userFunctionSource),
      timeoutMs: limits.timeoutMs,
      signal: input.signal,
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
          phase: errorPhase(error, deadlineExceeded),
          message: errorMessage(error)
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

// ---------------------------------------------------------------------------
// Refs: keep large returned/emitted values inside the isolate.
// ---------------------------------------------------------------------------

const REF_HELPERS_SOURCE = `
globalThis.__tackRefHelpers = {
  len(v) { try { const s = JSON.stringify(v); return s == null ? -1 : s.length; } catch { return -1; } },
  describe(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) {
      const first = v.length ? v[0] : undefined;
      const keys = first && typeof first === "object" ? Object.keys(first).slice(0, 6).join(", ") : "";
      return "Array(" + v.length + ")" + (keys ? " <{ " + keys + " }>" : "");
    }
    const t = typeof v;
    if (t === "string") return "string (" + v.length + " chars)";
    if (t === "object") return "{ " + Object.keys(v).slice(0, 8).join(", ") + " }";
    return t;
  },
  preview(v, limit) {
    if (Array.isArray(v)) return v.slice(0, limit);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).slice(0, limit)) out[k] = v[k];
      return out;
    }
    if (typeof v === "string") return v.slice(0, limit * 40);
    return v;
  },
  slice(v, offset, limit) {
    if (Array.isArray(v) || typeof v === "string") {
      return { value: v.slice(offset, offset + limit), truncated: offset > 0 || v.length > offset + limit };
    }
    return { value: v, truncated: false };
  }
};
`;

interface RefSink {
  readonly scopeHandle: QuickJSHandle;
  readonly newRefNames: string[];
}

interface RefBridge {
  materialize(valueHandle: QuickJSHandle, sink: RefSink): unknown;
  deref(scopeHandle: QuickJSHandle, ref: string, options: { readonly offset: number; readonly limit: number }): DerefResult;
  dispose(): void;
}

async function createRefBridge(
  context: QuickJSAsyncContext,
  maxInlineResultBytes: number,
  maxOutputBytes: number
): Promise<RefBridge> {
  disposeHandle(context.unwrapResult(
    await context.evalCodeAsync(REF_HELPERS_SOURCE, "tack-ref-helpers.js", { type: "global" })
  ));
  const helpers = context.getProp(context.global, "__tackRefHelpers");
  const lenFn = context.getProp(helpers, "len");
  const describeFn = context.getProp(helpers, "describe");
  const previewFn = context.getProp(helpers, "preview");
  const sliceFn = context.getProp(helpers, "slice");
  let count = 0;

  const callNumber = (fn: QuickJSHandle, arg: QuickJSHandle): number => {
    const result = context.unwrapResult(context.callFunction(fn, helpers, [arg]));
    try {
      return context.getNumber(result);
    } finally {
      disposeHandle(result);
    }
  };
  const callString = (fn: QuickJSHandle, arg: QuickJSHandle): string => {
    const result = context.unwrapResult(context.callFunction(fn, helpers, [arg]));
    try {
      return context.getString(result);
    } finally {
      disposeHandle(result);
    }
  };
  const callValue = (fn: QuickJSHandle, args: QuickJSHandle[]): unknown => {
    const result = context.unwrapResult(context.callFunction(fn, helpers, args));
    try {
      return snapshotQuickJSValue(context, result);
    } finally {
      disposeHandle(result);
    }
  };

  return {
    materialize: (valueHandle, sink) => {
      if (context.typeof(valueHandle) === "undefined") {
        return undefined;
      }
      const len = callNumber(lenFn, valueHandle);
      if (len >= 0 && len <= maxInlineResultBytes) {
        return snapshotQuickJSValue(context, valueHandle);
      }

      count += 1;
      const name = `$${count}`;
      context.setProp(sink.scopeHandle, name, valueHandle);
      context.setProp(sink.scopeHandle, "$_", valueHandle);
      sink.newRefNames.push(name, "$_");

      const limitHandle = context.newNumber(REF_PREVIEW_LIMIT);
      let preview: unknown;
      try {
        preview = callValue(previewFn, [valueHandle, limitHandle]);
      } finally {
        disposeHandle(limitHandle);
      }
      return { __tackRef: name, type: callString(describeFn, valueHandle), preview };
    },
    deref: (scopeHandle, ref, options) => {
      const valueHandle = context.getProp(scopeHandle, ref);
      try {
        if (context.typeof(valueHandle) === "undefined") {
          return { ok: false, error: `No such ref "${ref}"` };
        }
        const offsetHandle = context.newNumber(options.offset);
        const limitHandle = context.newNumber(options.limit);
        let sliced: { readonly value: unknown; readonly truncated: boolean };
        try {
          sliced = callValue(sliceFn, [valueHandle, offsetHandle, limitHandle]) as {
            readonly value: unknown;
            readonly truncated: boolean;
          };
        } finally {
          disposeHandle(offsetHandle);
          disposeHandle(limitHandle);
        }
        const text = safeStringify(sliced.value);
        if (text !== undefined && Buffer.byteLength(text) > maxOutputBytes) {
          return { ok: false, error: "Value is too large; pass a smaller limit" };
        }
        return { ok: true, value: sliced.value, truncated: sliced.truncated };
      } finally {
        disposeHandle(valueHandle);
      }
    },
    dispose: () => {
      for (const handle of [sliceFn, previewFn, describeFn, lenFn, helpers]) {
        disposeHandle(handle);
      }
    }
  };
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value) ?? undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Sessions: one persistent context across many `exec` cells.
// ---------------------------------------------------------------------------

async function createQuickJSSession(
  limits: QuickJSLimits,
  options: CodeSessionOptions | undefined
): Promise<CodeSession> {
  const perCellTimeoutMs = Math.max(100, limits.timeoutMs);
  const maxLifetimeMs =
    typeof options?.maxLifetimeMs === "number" ? options.maxLifetimeMs : undefined;

  const context = await newAsyncContext();
  context.runtime.setMemoryLimit(limits.memoryMb * 1024 * 1024);
  context.runtime.setMaxStackSize(limits.maxStackBytes);

  const scopeHandle = context.newObject();
  const refs = await createRefBridge(context, limits.maxInlineResultBytes, limits.maxOutputBytes);
  const declaredNames = new Set<string>();
  const startedAtMs = Date.now();

  let closed = false;
  let running = false;
  let currentCell: Promise<unknown> = Promise.resolve();
  let cellDeadline = Number.POSITIVE_INFINITY;
  let cellAbort: AbortSignal | undefined;
  let cellDeadlineExceeded = false;

  context.runtime.setInterruptHandler(() => {
    cellDeadlineExceeded = cellDeadlineExceeded || Date.now() > cellDeadline;
    return closed || cellDeadlineExceeded || Boolean(cellAbort?.aborted);
  });

  const exec = async (
    input: NormalizedCodeRuntimeExecuteInput,
    signal: AbortSignal = new AbortController().signal
  ): Promise<ExecutionResult> => {
    if (closed) {
      return { ok: false, emitted: [], logs: [], error: { phase: "runtime", message: "Session is closed" } };
    }
    if (running) {
      return { ok: false, emitted: [], logs: [], error: { phase: "runtime", message: "Session is already running a cell" } };
    }
    if (maxLifetimeMs !== undefined && Date.now() - startedAtMs > maxLifetimeMs) {
      return { ok: false, emitted: [], logs: [], error: { phase: "timeout", message: `Session exceeded its ${maxLifetimeMs}ms lifetime` } };
    }

    running = true;
    const emitted: unknown[] = [];
    const logs: string[] = [];
    const state: RuntimeState = {
      context,
      invoker: input.invoker,
      emitted,
      logs,
      maxToolCalls: limits.maxToolCalls,
      maxToolRequestBytes: limits.maxToolRequestBytes,
      maxToolResponseBytes: limits.maxToolResponseBytes,
      closed: false,
      toolCalls: 0
    };

    cellAbort = signal;
    cellDeadlineExceeded = false;

    let cellNames: readonly string[] = [];
    const newRefNames: string[] = [];
    try {
      throwIfAborted(signal);
      const transpiled = await transpileSessionCell({
        code: input.code,
        toolsPrelude: input.toolsPrelude,
        priorNames: declaredNames
      });
      cellNames = transpiled.declaredNames;

      cellDeadline = Date.now() + perCellTimeoutMs;
      const result = await withTimeout({
        promise: runSessionCell(state, transpiled.source, { scopeHandle, refs, newRefNames }),
        timeoutMs: perCellTimeoutMs,
        signal,
        message: `QuickJS session cell timed out after ${perCellTimeoutMs}ms`
      });

      for (const name of [...cellNames, ...newRefNames]) {
        declaredNames.add(name);
      }

      return jsonExecutionResult({
        body: { ok: true, ...(result === undefined ? {} : { result }), emitted, logs },
        maxOutputBytes: limits.maxOutputBytes,
        outputLogs: logs
      });
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw error;
      }
      return jsonExecutionResult({
        body: {
          ok: false,
          emitted,
          logs,
          error: { phase: errorPhase(error, cellDeadlineExceeded), message: errorMessage(error) }
        },
        maxOutputBytes: limits.maxOutputBytes,
        outputLogs: logs
      });
    } finally {
      cellDeadline = Number.POSITIVE_INFINITY;
      cellAbort = undefined;
      state.closed = true;
      running = false;
    }
  };

  return {
    exec: (input, signal) => {
      const normalized = normalizeCodeRuntimeExecuteInput(input);
      if (!normalized.ok) {
        return Promise.resolve(normalized.result);
      }
      const pending = exec(normalized.value, signal);
      currentCell = pending.then(
        () => undefined,
        () => undefined
      );
      return pending;
    },
    deref: async (ref, derefOptions) => {
      if (closed) {
        return { ok: false, error: "Session is closed" };
      }
      return refs.deref(scopeHandle, ref, {
        offset: Math.max(0, Math.trunc(derefOptions?.offset ?? 0)),
        limit: Math.max(1, Math.trunc(derefOptions?.limit ?? DEREF_DEFAULT_LIMIT))
      });
    },
    close: async () => {
      if (closed) {
        return;
      }
      // Signal any in-flight cell to abort (the interrupt handler honours
      // `closed`), then wait for it to unwind before disposing the context.
      closed = true;
      await currentCell;
      refs.dispose();
      disposeHandle(scopeHandle);
      context.runtime.removeInterruptHandler();
      context.dispose();
    }
  };
}

interface SessionCellContext {
  readonly scopeHandle: QuickJSHandle;
  readonly refs: RefBridge;
  readonly newRefNames: string[];
}

async function runSessionCell(
  state: RuntimeState,
  userFunctionSource: string,
  cell: SessionCellContext
): Promise<unknown> {
  const context = state.context;
  const sink: RefSink = { scopeHandle: cell.scopeHandle, newRefNames: cell.newRefNames };
  const evalResult = await context.evalCodeAsync(userFunctionSource, "tack-cell.js", { type: "global" });
  const functionHandle = context.unwrapResult(evalResult);
  const invokeHandle = context.newFunction("__tackInvoke", (pathHandle, argsHandle) =>
    callToolFromQuickJS(state, pathHandle, argsHandle)
  );
  const consoleHandle = createConsoleHandle(state);
  const emitHandle = context.newFunction("emit", (valueHandle) => {
    state.emitted.push(cell.refs.materialize(valueHandle, sink));
    return context.undefined;
  });

  let returnHandle: QuickJSHandle | undefined;
  let resolvedHandle: QuickJSHandle | undefined;
  try {
    returnHandle = context.unwrapResult(context.callFunction(
      functionHandle,
      context.undefined,
      [invokeHandle, consoleHandle, emitHandle, cell.scopeHandle]
    ));
    drainPendingJobs(context);
    const resolvedPromise = context.resolvePromise(returnHandle);
    drainPendingJobs(context);
    const resolvedResult = await resolvedPromise;
    drainPendingJobs(context);
    resolvedHandle = context.unwrapResult(resolvedResult);
    return cell.refs.materialize(resolvedHandle, sink);
  } finally {
    disposeHandle(resolvedHandle);
    disposeHandle(returnHandle);
    disposeHandle(emitHandle);
    disposeHandle(consoleHandle);
    disposeHandle(invokeHandle);
    disposeHandle(functionHandle);
  }
}

async function transpileSessionCell(input: {
  readonly code: string;
  readonly toolsPrelude: string;
  readonly priorNames: ReadonlySet<string>;
}): Promise<{ readonly source: string; readonly declaredNames: readonly string[] }> {
  try {
    validateCodeModeUserCode(input.code);
    const rewritten = await rewriteCellScope(input.code, input.priorNames);
    const result = await transform(renderCodeModeUserFunctionSource({
      code: rewritten.code,
      toolsPrelude: input.toolsPrelude,
      fetchErrorMessage: "fetch is disabled in Tack QuickJS runtime",
      strict: true,
      scopeParam: true
    }), {
      loader: "ts",
      format: "cjs",
      target: "es2022",
      sourcemap: false,
      treeShaking: false
    });
    return { source: result.code, declaredNames: rewritten.declaredNames };
  } catch (error) {
    throw error instanceof CodeModeParseError ? error : new CodeModeParseError(errorMessage(error));
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
  const args = argsHandle ? snapshotQuickJSValue(context, argsHandle) ?? {} : {};
  const request = { path, args };

  try {
    assertJsonByteLimit(request, state.maxToolRequestBytes, "Tool bridge request");
  } catch (error) {
    rejectDeferred(state, deferred, errorMessage(error));
    return deferred.handle;
  }

  void Promise.resolve()
    .then(() => state.invoker.invoke(request))
    .then((result) => {
      if (state.closed) {
        return;
      }

      assertJsonByteLimit({ ok: true, result }, state.maxToolResponseBytes, "Tool bridge response");
      const resultHandle = toQuickJSJsonValue(context, result);
      try {
        deferred.resolve(resultHandle);
      } finally {
        disposeHandle(resultHandle);
      }
    })
    .catch((error) => {
      if (!state.closed) {
        rejectDeferred(state, deferred, errorMessage(error));
      }
    })
    .finally(() => {
      if (!state.closed) {
        drainPendingJobs(context);
      }
    });

  return deferred.handle;
}

function rejectDeferred(
  state: RuntimeState,
  deferred: ReturnType<QuickJSAsyncContext["newPromise"]>,
  message: string
): void {
  const errorHandle = state.context.newError(message);
  try {
    deferred.reject(errorHandle);
  } finally {
    disposeHandle(errorHandle);
  }
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

function drainPendingJobs(context: QuickJSAsyncContext): void {
  while (context.runtime.hasPendingJob()) {
    context.runtime.executePendingJobs().dispose();
  }
}

function disposeHandle(handle: QuickJSHandle | undefined): void {
  if (handle?.alive) {
    handle.dispose();
  }
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

function snapshotQuickJSValue(context: QuickJSAsyncContext, handle: QuickJSHandle): unknown {
  return snapshotJsonData(context.dump(handle));
}

function snapshotJsonData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "bigint") {
    throw new Error("BigInt values are not supported in Tack code-mode JSON data");
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    throw new Error("Cyclic JSON data is not supported in Tack code-mode");
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const snapshot = snapshotJsonData(item, seen);
        return snapshot === undefined ? null : snapshot;
      });
    }

    const output: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        continue;
      }

      const snapshot = snapshotJsonData(descriptor.value, seen);
      if (snapshot !== undefined) {
        output[key] = snapshot;
      }
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function toQuickJSJsonValue(context: QuickJSAsyncContext, value: unknown): QuickJSHandle {
  const snapshot = snapshotJsonData(value);
  if (snapshot === undefined) {
    return context.undefined;
  }
  if (snapshot === null) {
    return context.null;
  }
  if (typeof snapshot === "string") {
    return context.newString(snapshot);
  }
  if (typeof snapshot === "number") {
    return context.newNumber(snapshot);
  }
  if (typeof snapshot === "boolean") {
    return snapshot ? context.true : context.false;
  }
  if (Array.isArray(snapshot)) {
    const arrayHandle = context.newArray();
    for (let index = 0; index < snapshot.length; index += 1) {
      const itemHandle = toQuickJSJsonValue(context, snapshot[index]);
      context.setProp(arrayHandle, index, itemHandle);
      disposeHandle(itemHandle);
    }
    return arrayHandle;
  }

  const objectHandle = context.newObject();
  for (const [key, item] of Object.entries(snapshot as Record<string, unknown>)) {
    const itemHandle = toQuickJSJsonValue(context, item);
    context.defineProp(objectHandle, key, {
      value: itemHandle,
      enumerable: true,
      configurable: true
    });
    disposeHandle(itemHandle);
  }
  return objectHandle;
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

function errorPhase(error: unknown, deadlineExceeded: boolean): ExecuteErrorPhase {
  if (error instanceof CodeRuntimeTimeoutError || deadlineExceeded) {
    return "timeout";
  }
  return error instanceof CodeModeParseError ? "parse" : "runtime";
}
