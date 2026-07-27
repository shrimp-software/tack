export class CodeRuntimeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeRuntimeTimeoutError";
  }
}

export function withTimeout<T>(input: {
  readonly promise: Promise<T>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly message: string;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(abortReason(input.signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new CodeRuntimeTimeoutError(input.message));
    }, input.timeoutMs);

    if (input.signal.aborted) {
      abort();
      return;
    }

    input.signal.addEventListener("abort", abort, { once: true });
    input.promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    if (signal.aborted) {
      abort();
      return;
    }

    signal.addEventListener("abort", abort, { once: true });
  });
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

export function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (
    error === signal.reason ||
    error instanceof Error && error.name === "AbortError"
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Operation aborted");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
