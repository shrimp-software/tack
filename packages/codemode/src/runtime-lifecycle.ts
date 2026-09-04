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

/**
 * A timeout for runtime work which deliberately excludes time spent waiting on
 * an external tool. Tool calls are bounded independently by `toolTimeoutMs`.
 */
export function withActiveTimeout<T>(input: {
  readonly promise: Promise<T>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly isPaused: () => boolean;
  readonly message: string;
  readonly onTimeout?: ((error: CodeRuntimeTimeoutError) => void) | undefined;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let elapsedMs = 0;
    let sampledAt = Date.now();
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      input.signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(abortReason(input.signal));
    };
    const tick = () => {
      const now = Date.now();
      if (!input.isPaused()) elapsedMs += now - sampledAt;
      sampledAt = now;
      if (elapsedMs >= input.timeoutMs) {
        cleanup();
        const error = new CodeRuntimeTimeoutError(input.message);
        try {
          input.onTimeout?.(error);
        } catch {
          // Timeout cleanup must not change the timeout result.
        }
        reject(error);
        return;
      }
      timer = setTimeout(tick, 10);
    };

    if (input.signal.aborted) {
      abort();
      return;
    }
    input.signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(tick, 10);
    input.promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); }
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
  if (error instanceof Error) {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (descriptor && "value" in descriptor && typeof descriptor.value === "string") {
      return descriptor.value;
    }
  }
  try {
    return String(error);
  } catch {
    return "Unknown error";
  }
}
