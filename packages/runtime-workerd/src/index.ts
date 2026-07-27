import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodeModeParseError,
  CodeRuntimeTimeoutError,
  errorMessage,
  isAbortError,
  type CodeRuntime,
  type ExecutionResult,
  type NormalizedCodeRuntimeExecuteInput,
  normalizeCodeRuntimeExecuteInput,
  renderCodeModeUserFunctionSource,
  throwIfAborted,
  validateCodeModeUserCode
} from "@tack/codemode";
import { transform } from "esbuild";

import { startHostBridge } from "./host-bridge.js";
import {
  normalizeRuntimeOptions,
  type WorkerdRuntimeOptions,
  type WorkerdRuntimeSettings
} from "./options.js";
import {
  getAvailableLocalPort,
  runWorker,
  startWorkerdProcess,
  waitReady,
  type WorkerdProcess
} from "./process.js";
import { renderWorkerdConfig, renderWorkerModule } from "./worker-template.js";

export type { WorkerdRuntimeOptions } from "./options.js";
export { isWorkerdAvailable } from "./process.js";

export function createWorkerdRuntime(options: WorkerdRuntimeOptions = {}): CodeRuntime {
  const settings = normalizeRuntimeOptions(options);

  return {
    name: "workerd",
    isolation: "process",
    timeoutMs: settings.timeoutMs,
    execute: (input, signal = new AbortController().signal) => {
      const normalizedInput = normalizeExecuteInput(input);
      if (!normalizedInput.ok) {
        return Promise.resolve(normalizedInput.result);
      }

      return executeInWorkerd({
        ...normalizedInput.value,
        settings,
        signal
      });
    }
  };
}

interface ExecuteInWorkerdInput {
  readonly code: NormalizedCodeRuntimeExecuteInput["code"];
  readonly invoker: NormalizedCodeRuntimeExecuteInput["invoker"];
  readonly toolsPrelude: NormalizedCodeRuntimeExecuteInput["toolsPrelude"];
  readonly settings: WorkerdRuntimeSettings;
  readonly signal: AbortSignal;
}

const normalizeExecuteInput = normalizeCodeRuntimeExecuteInput;

async function executeInWorkerd(input: ExecuteInWorkerdInput): Promise<ExecutionResult> {
  const token = randomUUID();
  const executionId = randomUUID();
  const settings = {
    ...input.settings,
    timeoutMs: Math.max(100, input.settings.timeoutMs)
  };
  const tmp = join(tmpdir(), `tack-workerd-${process.pid}-${Date.now()}-${executionId}`);
  let host: { readonly port: number; readonly close: () => Promise<void> } | undefined;
  let workerd: WorkerdProcess | undefined;

  try {
    throwIfAborted(input.signal);
    host = await startHostBridge({
      token,
      invoker: input.invoker,
      maxRequestBytes: settings.maxToolRequestBytes,
      maxResponseBytes: settings.maxToolResponseBytes,
      signal: input.signal
    });
    const listenPort = await getAvailableLocalPort(input.signal);

    await mkdir(tmp, { recursive: true, mode: 0o700 });
    await writeFile(join(tmp, "worker.js"), renderWorkerModule({
      token,
      code: await transpileUserCode({
        code: input.code,
        toolsPrelude: input.toolsPrelude
      }),
      timeoutMs: settings.timeoutMs,
      maxOutputBytes: settings.maxOutputBytes,
      maxToolCalls: settings.maxToolCalls
    }), { mode: 0o600 });
    await writeFile(join(tmp, "config.capnp"), renderWorkerdConfig({
      listenPort,
      hostPort: host.port,
      ...(settings.memoryMb ? { memoryMb: settings.memoryMb } : {})
    }), { mode: 0o600 });

    workerd = startWorkerdProcess({
      configPath: join(tmp, "config.capnp"),
      workerdBin: settings.workerdBin,
      signal: input.signal
    });
    await waitReady(listenPort, token, settings.startupTimeoutMs, input.signal);

    const response = await runWorker({
      port: listenPort,
      timeoutMs: settings.timeoutMs,
      hostTimeoutGraceMs: settings.hostTimeoutGraceMs,
      signal: input.signal
    });
    return normalizeWorkerResponse(response);
  } catch (error) {
    if (isAbortError(error, input.signal)) {
      throw error;
    }

    return {
      ok: false,
      emitted: [],
      logs: [],
      error: {
        phase: error instanceof CodeRuntimeTimeoutError ? "timeout" : error instanceof CodeModeParseError ? "parse" : "runtime",
        message: withStderrTail(errorMessage(error), workerd?.stderrTail() ?? "")
      }
    };
  } finally {
    await workerd?.close();
    await host?.close();
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function withStderrTail(message: string, stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length === 0 ? message : `${message}\nworkerd stderr:\n${trimmed}`;
}

async function transpileUserCode(input: {
  readonly code: string;
  readonly toolsPrelude: string;
}): Promise<string> {
  try {
    validateCodeModeUserCode(input.code);
    const result = await transform(renderCodeModeUserFunctionSource({
      ...input,
      fetchErrorMessage: "fetch is disabled in Tack workerd runtime"
    }), {
      loader: "ts",
      format: "cjs",
      target: "es2022",
      sourcemap: false,
      treeShaking: false
    });
    return result.code;
  } catch (error) {
    throw error instanceof CodeModeParseError
      ? error
      : new CodeModeParseError(errorMessage(error));
  }
}

function normalizeWorkerResponse(response: ExecutionResult): ExecutionResult {
  return {
    ok: response.ok,
    ...(Object.hasOwn(response, "result") ? { result: response.result } : {}),
    emitted: Array.isArray(response.emitted) ? response.emitted : [],
    logs: Array.isArray(response.logs) ? response.logs : [],
    ...(response.error ? { error: response.error } : {})
  };
}
