import { createBoundedJobPool, probeRuntimeCapabilities, requireRuntimeCapability, type BoundedJobLimits, type BoundedJobPool, type RuntimeName, type RegisteredJobHandler } from "@cbxss/tack-host-jobs";
import { createValidationWorkerRunner, VALIDATION_HANDLER_NAME, type ValidationJobPool, type ValidationWorkerRunner } from "./worker-runner.js";

export interface TrustedValidationPoolOptions {
  readonly root: string;
  readonly runtime?: Exclude<RuntimeName, "unknown">;
  readonly limits?: BoundedJobLimits;
  readonly handlers?: Readonly<Record<string, RegisteredJobHandler>>;
}

export interface TrustedValidationPool {
  readonly pool: BoundedJobPool;
  readonly runner: ValidationWorkerRunner;
  close(): Promise<void>;
}

/** Create the one host-owned pool and fixed trusted-validation registration. */
export async function createTrustedValidationPool(options: TrustedValidationPoolOptions): Promise<TrustedValidationPool> {
  const capability = await probeRuntimeCapabilities();
  const requestedRuntime = options.runtime ?? capability.runtime;
  if (requestedRuntime !== capability.runtime) {
    throw new Error(`validation_runtime_mismatch:host=${capability.runtime}:requested=${requestedRuntime}`);
  }
  requireRuntimeCapability(capability);
  if (requestedRuntime !== "node") throw new Error(`validation_runtime_unsupported:${requestedRuntime}`);
  const pool = await createBoundedJobPool({
    root: options.root,
    runtime: requestedRuntime,
    ...(options.limits ? { limits: options.limits } : {}),
    handlers: {
      ...options.handlers,
      [VALIDATION_HANDLER_NAME]: {
        module: new URL("../dist/worker-handler.js", import.meta.url),
        exportName: "runValidationJob"
      }
    }
  });
  return {
    pool,
    runner: createValidationWorkerRunner({ jobs: pool as unknown as ValidationJobPool }),
    close: () => pool.close()
  };
}
