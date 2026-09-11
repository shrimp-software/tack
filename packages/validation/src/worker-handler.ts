import { createValidationJobHandler, ValidationKernel, type ValidationJob, type ValidationResult } from "./validation.js";

export interface ValidationWorkerValidationRequest {
  readonly type: "validate";
  readonly requestId: string;
  /** Safe JSON text; arbitrary host objects never cross postMessage. */
  readonly jobJson: string;
}

export interface ValidationWorkerStatsRequest {
  readonly type: "stats";
  readonly requestId: string;
}

export type ValidationWorkerRequest = ValidationWorkerValidationRequest | ValidationWorkerStatsRequest;

export interface ValidationWorkerResponse {
  readonly type: "validated";
  readonly requestId: string;
  /** Safe JSON text reconstructed by the trusted worker handler. */
  readonly resultJson: string;
}

export interface ValidationWorkerStatsResponse {
  readonly type: "stats";
  readonly requestId: string;
  readonly compileCount: number;
  readonly cacheSize: number;
}

export interface ValidationWorkerFailure {
  readonly type: "failed";
  readonly requestId: string;
  readonly code: "validation_worker_failed";
}

const workerKernel = new ValidationKernel();
const handler = createValidationJobHandler(workerKernel);

/** Fixed trusted host-jobs registration target. */
export function runValidationJob(input: unknown): ValidationResult {
  return handler(input as ValidationJob);
}

export function handleValidationWorkerRequest(
  request: ValidationWorkerRequest
): ValidationWorkerResponse | ValidationWorkerStatsResponse | ValidationWorkerFailure {
  try {
    if (typeof request.requestId !== "string") {
      return { type: "failed", requestId: request.requestId, code: "validation_worker_failed" };
    }
    if (request.type === "stats") {
      return {
        type: "stats",
        requestId: request.requestId,
        compileCount: workerKernel.compileCount,
        cacheSize: workerKernel.cacheSize()
      };
    }
    if (typeof request.jobJson !== "string") {
      return { type: "failed", requestId: request.requestId, code: "validation_worker_failed" };
    }
    const job = JSON.parse(request.jobJson) as ValidationJob;
    return {
      type: "validated",
      requestId: request.requestId,
      resultJson: JSON.stringify(handler(job))
    };
  } catch {
    return { type: "failed", requestId: request.requestId, code: "validation_worker_failed" };
  }
}
