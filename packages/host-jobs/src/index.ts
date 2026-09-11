import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { createAdmissionCoordinator, type AdmissionCoordinator, type CoordinatorLease } from "./coordinator.js";

export { openStateDatabase, ensureStateDirectory, configureStateDatabase, beginImmediate, commit, rollback, type StateDatabase, type StateStatement } from "./sqlite.js";
export { probeRuntimeCapabilities, requireRuntimeCapability, runtimeCapabilityAvailable, type RuntimeCapabilityEvidence, type RuntimeCapabilityName, type RuntimeCapabilityProbeOptions, type RuntimeCapabilityStatus, type RuntimeName } from "./runtime-capabilities.js";
import { ensureStateDirectory } from "./sqlite.js";

export const HOST_JOB_DEFAULTS = {
  maxRootConcurrent: 2,
  maxOwnerConcurrent: 1,
  maxJobMs: 5_000,
  maxJsonDepth: 64,
  maxNodes: 1_000_000,
  maxInputBytes: 32 * 1024 * 1024,
  busyTimeoutMs: 5_000
} as const;

export interface BoundedJobLimits {
  readonly maxRootConcurrent?: number;
  readonly maxOwnerConcurrent?: number;
  readonly maxJobMs?: number;
  readonly maxJsonDepth?: number;
  readonly maxNodes?: number;
  readonly maxInputBytes?: number;
  readonly busyTimeoutMs?: number;
}

export interface JobHandlerContext {
  readonly signal?: AbortSignal;
  readonly deadline: number;
  readonly kind: string;
}

export type JobHandler = (input: unknown, context: JobHandlerContext) => unknown | Promise<unknown>;

export interface RegisteredJobHandler {
  readonly module: string | URL;
  readonly exportName?: string;
}

export interface BoundedJobPoolOptions {
  readonly root: string;
  readonly databasePath?: string;
  readonly limits?: BoundedJobLimits;
  /** Optional process-local registrations. The module is trusted host code, never agent code. */
  readonly handlers?: ReadonlyMap<string, RegisteredJobHandler> | Record<string, RegisteredJobHandler>;
  readonly runtime?: "node" | "bun";
}

export interface JobRequest {
  readonly kind: string;
  readonly ownerKey: string;
  readonly input?: unknown;
  /** A per-request ceiling; the queue wait is included. */
  readonly deadlineMs?: number;
  /** Host-only cancellation; it is never included in worker input. */
  readonly signal?: AbortSignal;
  /** Optional handler registered by the host. */
  readonly handler?: string;
}

export interface JobSuccess<T = unknown> {
  readonly ok: true;
  readonly value: T;
  readonly jobId: string;
}

export type JobFailureCode = "job_queue_timeout" | "job_timeout" | "job_cancelled" | "job_fenced" | "job_worker_error" | "job_handler_error" | "job_input_too_large" | "job_pool_closed" | "job_handler_missing" | "job_admission_error";
export interface JobFailure {
  readonly ok: false;
  readonly code: JobFailureCode;
  readonly jobId?: string;
  readonly message: string;
}

export type JobResult<T = unknown> = JobSuccess<T> | JobFailure;

export interface BoundedJobPool {
  submit<T = unknown>(request: JobRequest): Promise<JobResult<T>>;
  /** Cancels queued work or terminates its worker; a committed host result is never replayed. */
  cancel(jobId: string): boolean;
  register(name: string, handler: RegisteredJobHandler): void;
  close(): Promise<void>;
}

interface QueueEntry {
  readonly id: string;
  readonly request: JobRequest;
  readonly deadline: number;
  readonly resolve: (result: JobResult) => void;
  readonly reject: (error: unknown) => void;
  started: boolean;
  cancelled: boolean;
  expired: boolean;
  settled: boolean;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

interface ActiveEntry {
  readonly entry: QueueEntry;
  readonly lease: Lease;
  readonly worker: WorkerLike;
  readonly abort: AbortController;
  readonly completion: Promise<JobResult>;
  readonly handlerName: string;
}

interface Lease {
  readonly jobId: string;
  readonly ownerKey: string;
  readonly fence: string;
  readonly coordinatorLease: CoordinatorLease;
}

interface WorkerLike {
  terminate(): Promise<number> | void;
  onmessage?: ((event: { readonly data: unknown }) => void) | null;
  onerror?: ((error: unknown) => void) | null;
  once?: (event: string, callback: (...args: any[]) => void) => void;
  removeListener?: (event: string, callback: (...args: any[]) => void) => void;
  addEventListener?: (event: string, callback: (...args: any[]) => void) => void;
  removeEventListener?: (event: string, callback: (...args: any[]) => void) => void;
  postMessage(message: unknown): void;
}

/**
 * A cross-process, SQLite-fenced worker pool. SQLite owns admission; the
 * process-local queue is only a waiter and never a second quota authority.
 */
export async function createBoundedJobPool(options: BoundedJobPoolOptions): Promise<BoundedJobPool> {
  const limits = normalizeLimits(options.limits);
  const databasePath = options.databasePath ?? join(options.root, ".tack", "state.sqlite");
  await ensureStateDirectory(databasePath);
  const coordinator = await createAdmissionCoordinator({ databasePath, runtime: options.runtime ?? runtimeName(), limits, rootKey: options.root });
  const handlers = new Map<string, RegisteredJobHandler>();
  if (options.handlers instanceof Map) for (const [name, handler] of options.handlers) handlers.set(name, handler);
  else if (options.handlers) for (const [name, handler] of Object.entries(options.handlers)) handlers.set(name, handler);
  const queue: QueueEntry[] = [];
  const active = new Map<string, ActiveEntry>();
  const idleWorkers = new Map<string, WorkerLike[]>();
  let closed = false;
  let pumping = false;
  let pumpAgain = false;
  let closePromise: Promise<void> | undefined;
  const pendingAcquisitions = new Set<Promise<Lease | undefined>>();
  const pendingCoordinatorRequests = new Set<Promise<unknown>>();
  const pendingCleanup = new Set<Promise<void>>();
  const executing = new Set<Promise<void>>();
  const cleanupErrors: unknown[] = [];
  const terminationPromises = new Map<WorkerLike, Promise<void>>();
  const trackTermination = (worker: WorkerLike): Promise<void> => {
    const existing = terminationPromises.get(worker);
    if (existing) return existing;
    const termination = Promise.resolve().then(() => terminateWorker(worker));
    terminationPromises.set(worker, termination);
    void termination.catch((error) => cleanupErrors.push(error)).finally(() => { if (terminationPromises.get(worker) === termination) terminationPromises.delete(worker); });
    return termination;
  };

  const pool: BoundedJobPool = {
    submit<T>(request: JobRequest): Promise<JobResult<T>> {
      const now = Date.now();
      const maxMs = request.deadlineMs ?? limits.maxJobMs;
      if (!Number.isSafeInteger(maxMs) || maxMs <= 0 || maxMs > limits.maxJobMs) {
        return Promise.resolve({ ok: false, code: "job_queue_timeout", message: "job deadline is invalid or exceeds the bounded job limit" });
      }
      if (closed) return Promise.resolve({ ok: false, code: "job_pool_closed", message: "job pool is closed" });
      if (request.signal?.aborted) return Promise.resolve({ ok: false, code: "job_cancelled", message: "job was already cancelled" });
      if (!request.kind || !request.ownerKey) return Promise.resolve({ ok: false, code: "job_admission_error", message: "job kind and ownerKey are required" });
      if (request.handler && !handlers.has(request.handler)) return Promise.resolve({ ok: false, code: "job_handler_missing", message: "job handler is not registered" });
      const hasInput = Object.prototype.hasOwnProperty.call(request, "input");
      const inputText = hasInput ? safeInputText(request.input, limits.maxInputBytes, limits.maxJsonDepth, limits.maxNodes) : undefined;
      if (hasInput && inputText === undefined) return Promise.resolve({ ok: false, code: "job_input_too_large", message: "job input exceeds the bounded JSON input limits" });
      const id = `job_${randomUUID()}`;
      // Never pass the caller's object to structuredClone/postMessage: cloning
      // arbitrary objects can invoke getters. The worker receives a fresh plain
      // value reconstructed from our descriptor-free JSON encoding.
      const safeInput = inputText === undefined ? undefined : JSON.parse(inputText) as unknown;
      const safeRequest = { ...request, ...(safeInput === undefined ? {} : { input: safeInput }) };
      return new Promise<JobResult<T>>((resolve, reject) => {
        const entry: QueueEntry = { id, request: safeRequest, deadline: now + maxMs, resolve: resolve as (result: JobResult) => void, reject, started: false, cancelled: false, expired: false, settled: false };
        entry.deadlineTimer = setTimeout(() => {
          entry.expired = true;
          entry.cancelled = true;
          const running = active.get(id);
          if (running) {
            running.abort.abort();
            settle(entry, { ok: false, code: "job_timeout", jobId: id, message: "job deadline elapsed" });
          } else {
            const index = queue.indexOf(entry);
            if (index >= 0) queue.splice(index, 1);
            settle(entry, { ok: false, code: "job_queue_timeout", jobId: id, message: "job expired while queued" });
            void pump();
          }
        }, maxMs);
        if (request.signal) {
          const onAbort = () => {
            entry.cancelled = true;
            if (entry.started) {
              const running = active.get(id);
              running?.abort.abort();
            } else {
              const index = queue.indexOf(entry);
              if (index >= 0) queue.splice(index, 1);
              settle(entry, { ok: false, code: "job_cancelled", jobId: id, message: "job cancelled while queued" });
              void pump();
            }
          };
          request.signal.addEventListener("abort", onAbort, { once: true });
          entry.removeAbortListener = () => request.signal?.removeEventListener("abort", onAbort);
        }
        queue.push(entry);
        void pump();
      });
    },
    cancel(jobId) {
      const queued = queue.find((entry) => entry.id === jobId);
      if (queued) {
        queued.cancelled = true;
        settle(queued, { ok: false, code: "job_cancelled", jobId, message: "job cancelled while queued" });
        void pump();
        return true;
      }
      const running = active.get(jobId);
      if (!running) return false;
      running.entry.cancelled = true;
      running.abort.abort();
      settle(running.entry, { ok: false, code: "job_cancelled", jobId, message: "job cancelled" });
      void trackTermination(running.worker);
      return true;
    },
    register(name, handler) {
      if (!name || handlers.has(name)) throw new Error("job_handler_name_conflict");
      handlers.set(name, handler);
    },
    async close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        const errors: unknown[] = [];
        while (queue.length) {
          const entry = queue.shift();
          if (entry) { settle(entry, { ok: false, code: "job_pool_closed", jobId: entry.id, message: "job pool is closed" }); }
        }
        for (const current of active.values()) {
          current.entry.cancelled = true;
          current.abort.abort();
          settle(current.entry, { ok: false, code: "job_cancelled", jobId: current.entry.id, message: "job pool is closing" });
          try { await trackTermination(current.worker); } catch (error) { errors.push(error); }
        }
        await Promise.allSettled([...active.values()].map((current) => current.completion));
        await Promise.allSettled([...executing]);
        await Promise.allSettled([...terminationPromises.values()]);
        // An admission response can invoke close synchronously before the
        // pump continuation observes it. Drain admission, release, and their
        // microtask continuations before shutting down the coordinator.
        for (let turn = 0; turn < 3; turn += 1) {
          await Promise.resolve();
          await Promise.allSettled([...pendingAcquisitions]);
          await Promise.allSettled([...pendingCoordinatorRequests]);
          await Promise.allSettled([...pendingCleanup]);
        }
        await Promise.allSettled([...active.values()].map(async (current) => {
          try { await releaseLease(coordinator, current.lease, "cancelled"); } catch (error) { errors.push(error); }
        }));
        errors.push(...cleanupErrors);
        for (const workers of idleWorkers.values()) for (const worker of workers) void trackTermination(worker);
        idleWorkers.clear();
        await Promise.allSettled([...terminationPromises.values()]);
        active.clear();
        await coordinator.close();
        if (errors.length) throw new AggregateError(errors, "job_pool_close_failed");
      })();
      return closePromise;
    }
  };

  async function pump(): Promise<void> {
    if (pumping) { pumpAgain = true; return; }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        let progressed = true;
        while (progressed && !closed) {
          progressed = false;
          const index = queue.findIndex((entry) => !entry.cancelled);
          if (index < 0) break;
          const entry = queue[index];
          if (!entry) break;
          if (Date.now() >= entry.deadline) {
            queue.splice(index, 1);
            entry.expired = true;
            entry.cancelled = true;
            settle(entry, { ok: false, code: "job_queue_timeout", jobId: entry.id, message: "job expired while queued" });
            progressed = true;
            continue;
          }
          const acquisition = tryAcquireLease(coordinator, entry, limits, (request) => { pendingCoordinatorRequests.add(request); void request.then(() => pendingCoordinatorRequests.delete(request), () => pendingCoordinatorRequests.delete(request)); }, (cleanup) => { pendingCleanup.add(cleanup); void cleanup.catch((error) => cleanupErrors.push(error)).finally(() => pendingCleanup.delete(cleanup)); });
          pendingAcquisitions.add(acquisition);
          const lease = await acquisition.finally(() => pendingAcquisitions.delete(acquisition));
          if (!lease) break;
          queue.splice(index, 1);
          if (closed || entry.cancelled || Date.now() >= entry.deadline) {
            const cleanup = releaseLease(coordinator, lease, "cancelled").then(() => undefined);
            pendingCleanup.add(cleanup);
            try { await cleanup; } catch (error) { cleanupErrors.push(error); } finally { pendingCleanup.delete(cleanup); }
            entry.cancelled = true;
            settle(entry, { ok: false, code: entry.expired ? "job_queue_timeout" : "job_cancelled", jobId: entry.id, message: entry.expired ? "job expired before worker start" : "job cancelled before worker start" });
            progressed = true;
            continue;
          }
          entry.started = true;
          progressed = true;
          const execution = execute(entry, lease);
          executing.add(execution);
          void execution.finally(() => executing.delete(execution));
        }
        if (queue.some((entry) => !entry.cancelled && Date.now() < entry.deadline) && !closed) {
          await sleep(10);
          pumpAgain = true;
        }
      } while (pumpAgain && !closed);
    } finally { pumping = false; }
  }

  async function execute(entry: QueueEntry, lease: Lease): Promise<void> {
    const abort = new AbortController();
    const handlerName = entry.request.handler ?? "";
    const registered = handlerName ? handlers.get(handlerName) : undefined;
    let result: JobResult;
    let worker: WorkerLike | undefined;
    try {
      worker = idleWorkers.get(handlerName)?.pop();
      if (!worker) worker = createWorker(options.runtime ?? runtimeName(), registered, limits);
      const completion = runWorker(worker, entry, lease, limits, abort, registered, trackTermination);
      const current: ActiveEntry = { entry, lease, worker, abort, completion, handlerName };
      active.set(entry.id, current);
      result = await completion;
    } catch (error) {
      result = { ok: false, code: "job_worker_error", jobId: entry.id, message: boundedMessage(error) };
    }
    let finalResult: JobResult = result;
    try {
      if (result.ok && (entry.cancelled || entry.request.signal?.aborted)) finalResult = { ok: false, code: entry.expired ? "job_timeout" : "job_cancelled", jobId: entry.id, message: entry.expired ? "job deadline elapsed before result publication" : "job cancelled before result publication" };
      else if (result.ok && !(await isLeaseLive(coordinator, lease))) finalResult = { ok: false, code: "job_fenced", jobId: entry.id, message: "job lease expired before result publication" };
      const released = await releaseLease(coordinator, lease, finalResult.ok ? "finished" : finalResult.code === "job_fenced" ? "fenced" : "cancelled");
      if (finalResult.ok && Date.now() >= entry.deadline) finalResult = { ok: false, code: "job_timeout", jobId: entry.id, message: "job deadline elapsed during result publication" };
      else if (finalResult.ok && !released) finalResult = { ok: false, code: "job_fenced", jobId: entry.id, message: "job lease was not released as the live fence" };
      else if (finalResult.ok && (entry.cancelled || entry.request.signal?.aborted)) finalResult = { ok: false, code: entry.expired ? "job_timeout" : "job_cancelled", jobId: entry.id, message: entry.expired ? "job deadline elapsed during result publication" : "job cancelled during result publication" };
    } catch (error) {
      finalResult = { ok: false, code: "job_admission_error", jobId: entry.id, message: boundedMessage(error) };
    } finally {
      active.delete(entry.id);
      if (worker) {
        const reusable = finalResult.ok || (finalResult.code === "job_handler_error" && !entry.cancelled);
        if (reusable && !closed) {
          const workers = idleWorkers.get(handlerName) ?? [];
          workers.push(worker);
          idleWorkers.set(handlerName, workers);
        } else void trackTermination(worker);
      }
      settle(entry, finalResult);
      void pump();
    }
  }

  return pool;
}

function normalizeLimits(input: BoundedJobLimits | undefined): Required<BoundedJobLimits> {
  const result = { ...HOST_JOB_DEFAULTS, ...(input ?? {}) };
  for (const [name, value] of Object.entries(result)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid_job_limit:${name}`);
  if (result.maxRootConcurrent > HOST_JOB_DEFAULTS.maxRootConcurrent || result.maxOwnerConcurrent > HOST_JOB_DEFAULTS.maxOwnerConcurrent || result.maxJobMs > HOST_JOB_DEFAULTS.maxJobMs || result.maxJsonDepth > HOST_JOB_DEFAULTS.maxJsonDepth || result.maxNodes > HOST_JOB_DEFAULTS.maxNodes || result.maxInputBytes > HOST_JOB_DEFAULTS.maxInputBytes || result.busyTimeoutMs > HOST_JOB_DEFAULTS.busyTimeoutMs) throw new Error("job_limit_exceeds_hard_cap");
  return result;
}

function runtimeName(): "node" | "bun" {
  return typeof process !== "undefined" && typeof process.versions?.bun === "string" ? "bun" : "node";
}

function safeInputText(value: unknown, max: number, maxDepth: number, maxNodes: number): string | undefined {
  try {
    const text = strictJson(value, maxDepth, maxNodes);
    return Buffer.byteLength(text, "utf8") <= max ? text : undefined;
  } catch { return undefined; }
}

function strictJson(value: unknown, maxDepth: number, maxNodes: number): string {
  const seen = new Set<object>();
  let nodes = 0;
  function encode(input: unknown, depth: number): string {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) throw new Error("job_shape_limit");
    if (input === null) return "null";
    if (typeof input === "string") return JSON.stringify(input);
    if (typeof input === "boolean") return input ? "true" : "false";
    if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input);
    if (typeof input !== "object") throw new Error("job_non_json_input");
    if (seen.has(input)) throw new Error("job_cycle");
    const prototype = Object.getPrototypeOf(input);
    if (Array.isArray(input)) {
      seen.add(input);
      const values: string[] = [];
      for (let i = 0; i < input.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
        if (!descriptor || !("value" in descriptor)) throw new Error("job_sparse_or_accessor");
        values.push(encode(descriptor.value, depth + 1));
      }
      seen.delete(input);
      return `[${values.join(",")}]`;
    }
    if (prototype !== Object.prototype && prototype !== null) throw new Error("job_non_plain_input");
    seen.add(input);
    const values: string[] = [];
    for (const key of Object.keys(input).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("job_accessor");
      values.push(`${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`);
    }
    seen.delete(input);
    return `{${values.join(",")}}`;
  }
  return encode(value, 0);
}

async function tryAcquireLease(coordinator: AdmissionCoordinator, entry: QueueEntry, limits: Required<BoundedJobLimits>, trackRequest: (request: Promise<unknown>) => void, trackCleanup: (cleanup: Promise<void>) => void): Promise<Lease | undefined> {
  const nonce = randomUUID();
  try {
    const acquisition = coordinator.acquire({ jobId: entry.id, ownerKey: entry.request.ownerKey, nonce, deadline: entry.deadline });
    trackRequest(acquisition);
    const abortWait = entry.request.signal ? abortUntil(entry.request.signal) : undefined;
    let timedOut = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineWait = new Promise<undefined>((resolve) => { deadlineTimer = setTimeout(() => { timedOut = true; resolve(undefined); }, Math.max(1, entry.deadline - Date.now())); });
    const admitted = await Promise.race([acquisition, deadlineWait, ...(abortWait ? [abortWait.promise] : [])]);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    abortWait?.dispose();
    if (!admitted || timedOut || entry.cancelled || Date.now() >= entry.deadline) {
      // A raced-out coordinator request may still acquire in its worker. Fence
      // and release that late lease rather than leaking a slot.
      void acquisition.then((late) => { if (late) trackCleanup(coordinator.release(late, "cancelled").then(() => undefined)); });
      return undefined;
    }
    return { jobId: admitted.jobId, ownerKey: admitted.ownerKey, fence: admitted.fence, coordinatorLease: admitted };
  } catch (error) { throw new Error(`job_admission_error:${boundedMessage(error)}`); }
}

function abortUntil(signal: AbortSignal): { promise: Promise<undefined>; dispose: () => void } {
  if (signal.aborted) return { promise: Promise.resolve(undefined), dispose: () => undefined };
  let resolvePromise: (() => void) | undefined;
  const onAbort = () => resolvePromise?.();
  const promise = new Promise<undefined>((resolve) => { resolvePromise = () => resolve(undefined); signal.addEventListener("abort", onAbort, { once: true }); });
  return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}

async function isLeaseLive(coordinator: AdmissionCoordinator, lease: Lease): Promise<boolean> {
  return coordinator.isCurrent(lease.coordinatorLease, lease.coordinatorLease.deadline);
}

async function releaseLease(coordinator: AdmissionCoordinator, lease: Lease, state: "finished" | "cancelled" | "fenced"): Promise<boolean> {
  return coordinator.release(lease.coordinatorLease, state);
}

function createWorker(runtime: "node" | "bun", handler: RegisteredJobHandler | undefined, limits: Required<BoundedJobLimits>): WorkerLike {
  if (!handler) throw new Error("job_handler_missing");
  const request = { module: typeof handler.module === "string" ? handler.module : handler.module.href, exportName: handler.exportName ?? "default" };
  if (runtime === "bun") {
    const constructor = (globalThis as unknown as { Worker?: new (url: URL, options?: { type?: "module" }) => WorkerLike }).Worker;
    if (!constructor) throw new Error("job_bun_worker_unavailable");
    const worker = new constructor(new URL("./worker-bun.js", import.meta.url), { type: "module" });
    worker.postMessage(request);
    return worker;
  }
  return new Worker(new URL("./worker-node.js", import.meta.url), {
    execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type") && !argument.startsWith("--max-old-space-size")),
    resourceLimits: { maxOldGenerationSizeMb: 256 },
    workerData: request
  });
}

function runWorker(worker: WorkerLike, entry: QueueEntry, lease: Lease, limits: Required<BoundedJobLimits>, abort: AbortController, registered: RegisteredJobHandler | undefined, terminate: (worker: WorkerLike) => Promise<void>): Promise<JobResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let removeAbortListener = (): void => undefined;
    let cleanupWorkerListeners = (): void => undefined;
    const finish = (result: JobResult): void => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      cleanupWorkerListeners();
      resolve(result);
    };
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      // A timer wakeup can precede the wall-clock fence (clock granularity or
      // adjustment). It is neither a worker failure nor authority to expire
      // the job early. Recheck the same deadline used by admission.
      const remaining = entry.deadline - Date.now();
      if (remaining > 0) {
        timer = setTimeout(expire, remaining);
        return;
      }
      timedOut = true;
      abort.abort();
      void terminate(worker);
      finish({ ok: false, code: "job_timeout", jobId: entry.id, message: "job exceeded its bounded wall time" });
    };
    timer = setTimeout(expire, Math.max(1, entry.deadline - Date.now()));
    const onAbort = () => {
      if (timedOut) return;
      clearTimeout(timer);
      void terminate(worker);
      finish({ ok: false, code: entry.expired ? "job_timeout" : "job_cancelled", jobId: entry.id, message: entry.expired ? "job deadline elapsed" : "job cancelled" });
    };
    abort.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => abort.signal.removeEventListener("abort", onAbort);
    const message = (value: unknown): void => {
      if (typeof value !== "object" || value === null || (value as { jobId?: unknown }).jobId !== entry.id) return;
      clearTimeout(timer);
      if (entry.cancelled) finish({ ok: false, code: entry.expired ? "job_timeout" : "job_cancelled", jobId: entry.id, message: entry.expired ? "job deadline elapsed" : "job cancelled" });
      else if (isWorkerOk(value)) {
        try { finish({ ok: true, value: JSON.parse(value.valueJson), jobId: entry.id }); }
        catch (error) { finish({ ok: false, code: "job_worker_error", jobId: entry.id, message: boundedMessage(error) }); }
      }
      else if (typeof value === "object" && value !== null && (value as { jobId?: unknown }).jobId === entry.id && (value as { ok?: unknown }).ok === false) finish({ ok: false, code: "job_handler_error", jobId: entry.id, message: boundedMessage((value as { error?: unknown }).error) });
      else finish({ ok: false, code: "job_worker_error", jobId: entry.id, message: boundedMessage(value) });
    };
    const failure = (error: unknown): void => {
      clearTimeout(timer);
      finish({ ok: false, code: entry.expired ? "job_timeout" : entry.cancelled ? "job_cancelled" : "job_worker_error", jobId: entry.id, message: boundedMessage(error) });
    };
    if (worker.once) {
      const exit = (code: number) => { if (code !== 0) failure(new Error(`worker_exit:${code}`)); };
      worker.once("message", message);
      worker.once("error", failure);
      worker.once("exit", exit);
      cleanupWorkerListeners = () => {
        worker.removeListener?.("message", message);
        worker.removeListener?.("error", failure);
        worker.removeListener?.("exit", exit);
      };
    } else {
      worker.onmessage = (event) => message(event.data);
      worker.onerror = failure;
      cleanupWorkerListeners = () => { worker.onmessage = null; worker.onerror = null; };
    }
    worker.postMessage({ jobId: entry.id, input: entry.request.input, kind: entry.request.kind, deadline: entry.deadline, ...(registered ? { module: typeof registered.module === "string" ? registered.module : registered.module.href, exportName: registered.exportName ?? "default" } : {}) });
  });
}

function isWorkerOk(value: unknown): value is { ok: true; jobId: string; valueJson: string } {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true && typeof (value as { jobId?: unknown }).jobId === "string" && typeof (value as { valueJson?: unknown }).valueJson === "string";
}

async function terminateWorker(worker: WorkerLike): Promise<void> {
  if (worker.once) {
    const result = worker.terminate();
    if (result && typeof (result as Promise<number>).then === "function") await result;
    return;
  }
  if (worker.addEventListener) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        worker.removeEventListener?.("close", onClose);
        worker.removeEventListener?.("error", onError);
        if (error) reject(error); else resolve();
      };
      const onClose = () => finish();
      const onError = () => undefined;
      worker.addEventListener?.("close", onClose);
      worker.addEventListener?.("error", onError);
      try { worker.terminate(); } catch (error) { finish(error); }
    });
    return;
  }
  const result = worker.terminate();
  if (result && typeof (result as Promise<number>).then === "function") await result;
}

function settle(entry: QueueEntry, result: JobResult): void {
  if (entry.settled) return;
  entry.settled = true;
  if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);
  entry.removeAbortListener?.();
  entry.resolve(result);
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "worker failure";
  return message.slice(0, 512);
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
