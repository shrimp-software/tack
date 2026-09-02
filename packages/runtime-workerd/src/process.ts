import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodeRuntimeTimeoutError,
  delay,
  isAbortError,
  throwIfAborted,
  type ExecutionResult
} from "@cbxss/tack-codemode";
import type { Server } from "node:http";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRequire = createRequire(import.meta.url);

export interface WorkerdProcess {
  readonly stderrTail: () => string;
  close(): Promise<void>;
}

export function isWorkerdAvailable(workerdBin?: string): boolean {
  try {
    const result = spawnSync(resolveWorkerdBin(workerdBin), ["--version"], {
      stdio: "ignore"
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function startWorkerdProcess(input: {
  readonly configPath: string;
  readonly workerdBin?: string | undefined;
  readonly signal: AbortSignal;
}): WorkerdProcess {
  const proc = spawn(resolveWorkerdBin(input.workerdBin), [
    "serve",
    input.configPath,
    "--experimental"
  ]);
  proc.stdout.resume();

  const stderrTail = captureStderr(proc);
  const abort = () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
    }
  };
  input.signal.addEventListener("abort", abort, { once: true });

  return {
    stderrTail,
    close: async () => {
      input.signal.removeEventListener("abort", abort);
      if (proc.exitCode === null && proc.signalCode === null) {
        await killProcess(proc);
      }
    }
  };
}

export async function runWorker(input: {
  readonly port: number;
  readonly timeoutMs: number;
  readonly hostTimeoutGraceMs: number;
  readonly signal: AbortSignal;
}): Promise<ExecutionResult> {
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new CodeRuntimeTimeoutError(`Workerd runtime execution timed out after ${input.timeoutMs}ms`)),
    input.timeoutMs + input.hostTimeoutGraceMs
  );
  try {
    throwIfAborted(input.signal);
    const response = await fetch(`http://127.0.0.1:${input.port}/run`, {
      method: "POST",
      signal: controller.signal
    });
    const text = await response.text();
    const parsed = text.length > 0 ? JSON.parse(text) as unknown : {};
    if (!response.ok) {
      throw new Error(`workerd returned ${response.status}: ${text}`);
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as ExecutionResult;
    }
    throw new Error("workerd returned a non-object response");
  } catch (error) {
    if (isAbortError(error, input.signal)) {
      throw error;
    }

    if (
      error instanceof CodeRuntimeTimeoutError ||
      error instanceof Error && error.name === "AbortError"
    ) {
      throw new CodeRuntimeTimeoutError(`Workerd runtime execution timed out after ${input.timeoutMs}ms`);
    }
    throw error;
  } finally {
    input.signal.removeEventListener("abort", abort);
    clearTimeout(timer);
  }
}

export async function waitReady(port: number, token: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      throwIfAborted(signal);
      const response = await fetch(`http://127.0.0.1:${port}/__health`, { signal });
      const body = await response.json() as { readonly runnerToken?: unknown };
      if (body.runnerToken === token) {
        return;
      }
      lastError = new Error("health response token mismatch");
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw error;
      }

      lastError = error;
    }
    await delay(20, signal);
  }

  throw new Error(`workerd did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export function getAvailableLocalPort(signal: AbortSignal): Promise<number> {
  const server = createNetServer();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      server.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const abort = () => {
      cleanup();
      void closeServer(server);
      reject(signal.reason);
    };

    if (signal.aborted) {
      abort();
      return;
    }

    server.on("error", onError);
    signal.addEventListener("abort", abort, { once: true });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        const port = address.port;
        server.close((error) => {
          cleanup();
          if (error) {
            reject(error);
            return;
          }
          resolve(port);
        });
        return;
      }
      cleanup();
      reject(new Error("port reservation did not expose a TCP port"));
    });
  });
}

export function closeServer(server: Server | NetServer): Promise<void> {
  return new Promise((resolve) => {
    if ("closeAllConnections" in server) {
      server.closeAllConnections();
    }
    server.close(() => resolve());
  });
}

function captureStderr(proc: ChildProcessWithoutNullStreams): () => string {
  let tail = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-4000);
  });
  return () => tail;
}

function killProcess(proc: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    proc.once("exit", () => resolve());
    proc.kill("SIGKILL");
  });
}

function resolveWorkerdBin(workerdBin?: string): string {
  const configured = workerdBin ?? process.env["TACK_WORKERD_BIN"];
  if (configured) {
    if (existsSync(configured)) {
      return configured;
    }
    throw new Error(`Configured workerd binary does not exist: ${configured}`);
  }

  const candidates = [
    safeResolve("workerd/bin/workerd"),
    join(packageDir, "node_modules", "workerd", "bin", workerdBinaryName()),
    join(packageDir, "..", "..", "node_modules", "workerd", "bin", workerdBinaryName()),
    "workerd"
  ].filter((candidate): candidate is string => typeof candidate === "string");

  for (const candidate of candidates) {
    if (candidate === "workerd" || existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Unable to find workerd binary");
}

function safeResolve(specifier: string): string | undefined {
  try {
    return packageRequire.resolve(specifier);
  } catch {
    return undefined;
  }
}

function workerdBinaryName(): string {
  return process.platform === "win32" ? "workerd.exe" : "workerd";
}
