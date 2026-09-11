import type { ValidationCoverage, ValidationDiagnostic, ValidationDialect, ValidationJob, ValidationResult } from "./validation.js";

/** Fixed registration key for the trusted module installed by the host. */
export const VALIDATION_HANDLER_NAME = "trusted-validation" as const;

/** The host-jobs JobRequest seam, kept dependency-light for coordinator wiring. */
export interface ValidationJobRequest {
  readonly kind: "validation";
  readonly ownerKey: string;
  readonly input?: unknown;
  readonly deadlineMs?: number;
  readonly handler: typeof VALIDATION_HANDLER_NAME;
  /** Host-only cancellation; never enters worker input or receipts. */
  readonly signal?: AbortSignal | undefined;
}

export type ValidationJobResult<T = unknown> =
  | { readonly ok: true; readonly value: T; readonly jobId: string }
  | { readonly ok: false; readonly code: string; readonly jobId?: string; readonly message: string };

/** Structural shape of @cbxss/tack-host-jobs BoundedJobPool. */
export interface ValidationJobPool {
  submit<T = unknown>(request: ValidationJobRequest): Promise<ValidationJobResult<T>>;
}

export interface ValidationWorkerRunOptions {
  readonly ownerKey: string;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal | undefined;
}

export interface ValidationWorkerRunnerOptions {
  /** A host-owned @cbxss/tack-host-jobs BoundedJobPool. */
  readonly jobs: ValidationJobPool;
}

function failureResult(job: ValidationJob, code: string, message: string): ValidationResult {
  return Object.freeze({
    status: job.mode === "permissive" ? "skipped" : "unavailable",
    validator: "none" as const,
    coverage: Object.freeze({
      assertions: "not_performed" as const,
      schemaSupport: "unknown" as const,
      localRefs: false,
      remoteRefs: false as const,
      formatAssertions: false as const
    }),
    diagnostics: Object.freeze([{ code, message }]),
    ...(job.sourceRevision !== undefined ? { sourceRevision: job.sourceRevision } : {}),
    ...(job.effectiveRevision !== undefined ? { effectiveRevision: job.effectiveRevision } : {})
  });
}

const VALID_STATUSES = new Set(["passed", "failed", "partial", "unavailable", "skipped"]);
const VALID_VALIDATORS = new Set(["ajv", "none"]);
const VALID_DIALECTS = new Set(["draft-07", "2020-12"]);
const VALID_SUPPORT = new Set(["supported", "partial", "unsupported", "missing", "unknown"]);

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function ownString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = ownValue(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function whitelistDiagnostic(value: unknown): ValidationDiagnostic | undefined {
  const input = record(value);
  if (!input) return undefined;
  const code = ownString(input, "code");
  const message = ownString(input, "message");
  if (!code || !message) return undefined;
  const pointer = ownString(input, "pointer");
  const schemaPath = ownString(input, "schemaPath");
  const keyword = ownString(input, "keyword");
  const output: ValidationDiagnostic = {
    code,
    message,
    ...(pointer !== undefined ? { pointer } : {}),
    ...(schemaPath !== undefined ? { schemaPath } : {}),
    ...(keyword !== undefined ? { keyword } : {})
  };
  return byteLength(JSON.stringify(output)) <= 2 * 1024 ? Object.freeze(output) : undefined;
}

function whitelistCoverage(value: unknown): ValidationCoverage | undefined {
  const input = record(value);
  if (!input) return undefined;
  const assertions = ownString(input, "assertions");
  const schemaSupport = ownString(input, "schemaSupport");
  const localRefs = ownValue(input, "localRefs");
  const remoteRefs = ownValue(input, "remoteRefs");
  const formatAssertions = ownValue(input, "formatAssertions");
  if ((assertions !== "performed" && assertions !== "not_performed") ||
      !schemaSupport || !VALID_SUPPORT.has(schemaSupport) ||
      typeof localRefs !== "boolean" || remoteRefs !== false || formatAssertions !== false) return undefined;
  return Object.freeze({
    assertions,
    schemaSupport: schemaSupport as ValidationCoverage["schemaSupport"],
    localRefs,
    remoteRefs: false,
    formatAssertions: false
  });
}

/** Whitelist worker evidence; never spread a pool result or submitted metadata. */
function whitelistValidationEvidence(value: unknown, job: ValidationJob): ValidationResult | undefined {
  const input = record(value);
  const status = input ? ownString(input, "status") : undefined;
  const validator = input ? ownString(input, "validator") : undefined;
  const coverage = whitelistCoverage(input ? ownValue(input, "coverage") : undefined);
  const rawDiagnostics = input ? ownValue(input, "diagnostics") : undefined;
  const diagnostics = Array.isArray(rawDiagnostics)
    ? Array.prototype.map.call(rawDiagnostics, whitelistDiagnostic) as Array<ValidationDiagnostic | undefined>
    : undefined;
  if (!status || !VALID_STATUSES.has(status) || !validator || !VALID_VALIDATORS.has(validator) || !coverage ||
      !diagnostics || diagnostics.length > 1 || diagnostics.some((item) => item === undefined)) return undefined;
  const dialect = input ? ownString(input, "dialect") : undefined;
  const hash = input ? ownString(input, "effectiveContractHash") : undefined;
  if (dialect !== undefined && !VALID_DIALECTS.has(dialect)) return undefined;
  if (hash !== undefined && !/^[0-9a-f]{64}$/u.test(hash)) return undefined;
  const output: ValidationResult = {
    status: status as ValidationResult["status"],
    validator: validator as ValidationResult["validator"],
    ...(dialect !== undefined ? { dialect: dialect as ValidationDialect } : {}),
    ...(hash !== undefined ? { effectiveContractHash: hash } : {}),
    coverage,
    diagnostics: Object.freeze(diagnostics as ValidationDiagnostic[]),
    ...(job.sourceRevision !== undefined ? { sourceRevision: job.sourceRevision } : {}),
    ...(job.effectiveRevision !== undefined ? { effectiveRevision: job.effectiveRevision } : {})
  };
  return byteLength(JSON.stringify(output)) <= 8 * 1024 ? Object.freeze(output) : undefined;
}

function snapshotJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite JSON value");
    return value;
  }
  if (typeof value !== "object") throw new Error("non-JSON validation payload");
  if (seen.has(value)) throw new Error("cyclic validation payload");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("unsafe array validation payload");
        out.push(snapshotJson(descriptor.value, seen));
      }
      for (const key of Object.keys(value)) {
        if (!/^\d+$/u.test(key) || Number(key) >= value.length) throw new Error("unsafe array validation payload");
      }
      return out;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("non-plain validation payload");
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("accessor validation payload");
      Object.defineProperty(out, key, {
        value: snapshotJson(descriptor.value, seen),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function snapshotJob(job: ValidationJob): ValidationJob {
  const object = job as unknown as Record<string, unknown>;
  const read = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const purpose = read("purpose");
  if (purpose !== "input" && purpose !== "output") throw new Error("invalid validation purpose");
  const mode = read("mode");
  if (mode !== undefined && mode !== "strict" && mode !== "permissive") throw new Error("invalid validation mode");
  const sourceRevision = read("sourceRevision");
  const effectiveRevision = read("effectiveRevision");
  if (sourceRevision !== undefined && typeof sourceRevision !== "string") throw new Error("invalid source revision");
  if (effectiveRevision !== undefined && typeof effectiveRevision !== "string") throw new Error("invalid effective revision");
  const schema = read("schema");
  return {
    purpose,
    ...(schema !== undefined ? { schema: snapshotJson(schema) as ValidationJob["schema"] } : {}),
    value: snapshotJson(read("value")),
    ...(mode !== undefined ? { mode } : {}),
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    ...(effectiveRevision !== undefined ? { effectiveRevision } : {})
  };
}

function mapPoolFailure(code: string): { readonly code: string; readonly message: string } {
  if (code === "job_cancelled") return { code: "validation_cancelled", message: "Validation was cancelled" };
  if (code === "job_timeout" || code === "job_queue_timeout") return { code: "validation_worker_timeout", message: "Validation exceeded its bounded deadline" };
  return { code: "validation_worker_failed", message: "Validation worker failed without a result" };
}

/**
 * Validation adapter over the shared host-jobs pool. The pool owns job IDs,
 * nonce/fence state, queue deadlines, cancellation, worker lifecycle, and
 * final fence acceptance. This runner owns only validation evidence mapping.
 */
export class ValidationWorkerRunner {
  private readonly jobs: ValidationJobPool;

  constructor(options: ValidationWorkerRunnerOptions) {
    this.jobs = options.jobs;
  }

  async run(job: ValidationJob, options: ValidationWorkerRunOptions): Promise<ValidationResult> {
    if (options.deadlineMs !== undefined && (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= 0)) {
      return failureResult(job, "validation_deadline_invalid", "Validation deadline is invalid");
    }
    if (options.signal?.aborted) return failureResult(job, "validation_cancelled", "Validation was cancelled");

    let safeJob: ValidationJob;
    try {
      safeJob = snapshotJob(job);
    } catch {
      return failureResult(job, "validation_transfer_unsupported", "Validation requires parsed JSON data without accessors or cycles");
    }

    // Revisions are evidence retained by the host adapter, not authority sent
    // to the worker. The fixed registered handler receives checking fields only.
    const input = {
      purpose: safeJob.purpose,
      ...(safeJob.schema !== undefined ? { schema: safeJob.schema } : {}),
      value: safeJob.value,
      ...(safeJob.mode !== undefined ? { mode: safeJob.mode } : {})
    };
    let submitted: ValidationJobResult<ValidationResult>;
    try {
      submitted = await this.jobs.submit<ValidationResult>({
        kind: "validation",
        ownerKey: options.ownerKey,
        input,
        ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
        handler: VALIDATION_HANDLER_NAME,
        ...(options.signal !== undefined ? { signal: options.signal } : {})
      });
    } catch {
      return failureResult(safeJob, "validation_worker_failed", "Validation job submission failed");
    }

    if (!submitted.ok) {
      const failure = mapPoolFailure(submitted.code);
      return failureResult(safeJob, failure.code, failure.message);
    }
    const evidence = whitelistValidationEvidence(submitted.value, safeJob);
    return evidence ?? failureResult(safeJob, "validation_worker_failed", "Validation worker returned invalid checking evidence");
  }
}

export function createValidationWorkerRunner(options: ValidationWorkerRunnerOptions): ValidationWorkerRunner {
  return new ValidationWorkerRunner(options);
}
