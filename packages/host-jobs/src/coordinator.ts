import { Worker } from "node:worker_threads";
import { openStateDatabase, configureStateDatabase, type StateDatabase } from "./sqlite.js";
import type { BoundedJobLimits } from "./index.js";

export interface AdmissionCoordinatorOptions {
  readonly databasePath: string;
  readonly runtime: "node" | "bun";
  readonly limits: Required<BoundedJobLimits>;
  readonly rootKey: string;
}

export interface CoordinatorLease {
  readonly jobId: string;
  readonly ownerKey: string;
  readonly rootKey: string;
  readonly nonce: string;
  readonly fence: string;
  readonly deadline: number;
}

interface CoordinatorWorker {
  postMessage(value: unknown): void;
  terminate(): Promise<number> | void;
  once?(event: string, callback: (...args: any[]) => void): void;
  on?(event: string, callback: (...args: any[]) => void): void;
  addEventListener?: (event: string, callback: (...args: any[]) => void, options?: unknown) => void;
  removeEventListener?: (event: string, callback: (...args: any[]) => void) => void;
  onmessage?: ((event: { readonly data: unknown }) => void) | null;
  onerror?: ((error: unknown) => void) | null;
}

export interface AdmissionCoordinator {
  acquire(input: { jobId: string; ownerKey: string; nonce: string; deadline: number }): Promise<CoordinatorLease | undefined>;
  isCurrent(lease: CoordinatorLease, deadline: number): Promise<boolean>;
  release(lease: CoordinatorLease, state: "finished" | "cancelled" | "fenced"): Promise<boolean>;
  close(): Promise<void>;
}

export async function createAdmissionCoordinator(options: AdmissionCoordinatorOptions): Promise<AdmissionCoordinator> {
  const worker = startWorker(options);
  let sequence = 0;
  let closed = false;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  const onMessage = (message: unknown): void => {
    if (!message || typeof message !== "object") return;
    const value = message as { id?: unknown; ok?: unknown; value?: unknown; error?: unknown };
    if (value.id === undefined) return;
    const waiter = pending.get(Number(value.id));
    if (!waiter) return;
    pending.delete(Number(value.id));
    clearTimeout(waiter.timer);
    if (value.ok === true) waiter.resolve(value.value);
    else waiter.reject(new Error(typeof value.error === "string" ? value.error : "job_coordinator_error"));
  };
  const rejectPending = (error: unknown): void => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); } pending.clear(); };
  if (worker.on) { worker.on("message", onMessage); worker.on("error", (error) => rejectPending(error)); }
  else { worker.onmessage = (event) => onMessage(event.data); worker.onerror = (error) => rejectPending(error); }
  await request("ready", {}, Date.now() + options.limits.maxJobMs);

  async function request(operation: string, input: unknown, deadline?: number): Promise<any> {
    if (closed && operation !== "close") throw new Error("job_coordinator_closed");
    const id = ++sequence;
    const waitMs = deadline === undefined ? options.limits.maxJobMs : Math.max(1, Math.min(options.limits.maxJobMs, deadline - Date.now()));
    const result = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error("job_coordinator_timeout")); }, waitMs);
      pending.set(id, { resolve, reject, timer });
    });
    worker.postMessage({ id, operation, input });
    return result;
  }

  return {
    acquire: async (input) => {
      try { return await request("acquire", { ...input, rootKey: options.rootKey, limits: { maxRootConcurrent: options.limits.maxRootConcurrent, maxOwnerConcurrent: options.limits.maxOwnerConcurrent } }, input.deadline) as CoordinatorLease | undefined; }
      catch { return undefined; }
    },
    isCurrent: async (lease, deadline) => { try { return Boolean(await request("current", { lease, deadline }, deadline)); } catch { return false; } },
    release: async (lease, state) => Boolean(await request("release", { lease, state, deadline: lease.deadline }, Date.now() + options.limits.maxJobMs)),
    async close() {
      if (closed) return;
      closed = true;
      rejectPending(new Error("job_coordinator_closed"));
      try { await terminate(worker); } catch (error) { throw error; }
    }
  };
}

function startWorker(options: AdmissionCoordinatorOptions): CoordinatorWorker {
  const input = { databasePath: options.databasePath, limits: options.limits };
  if (options.runtime === "bun") {
    const Constructor = (globalThis as unknown as { Worker?: new (url: URL, options?: { type?: "module" }) => CoordinatorWorker }).Worker;
    if (!Constructor) throw new Error("job_bun_worker_unavailable");
    const worker = new Constructor(new URL("./coordinator-bun.js", import.meta.url), { type: "module" });
    worker.postMessage({ operation: "init", input });
    return worker;
  }
  return new Worker(new URL("./coordinator-node.js", import.meta.url), { execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")), workerData: input });
}

async function terminate(worker: CoordinatorWorker): Promise<void> {
  if (worker.once) {
    const value = worker.terminate();
    if (value && typeof (value as Promise<number>).then === "function") await value;
    return;
  }
  if (worker.addEventListener) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onClose = () => {
        if (settled) return;
        settled = true;
        worker.removeEventListener?.("close", onClose);
        resolve();
      };
      worker.addEventListener?.("close", onClose, { once: true });
      try { worker.terminate(); } catch (error) {
        if (!settled) { settled = true; worker.removeEventListener?.("close", onClose); reject(error); }
      }
    });
    return;
  }
  const value = worker.terminate();
  if (value && typeof (value as Promise<number>).then === "function") await value;
}

export async function prepareCoordinatorDatabase(databasePath: string, busyTimeoutMs: number): Promise<void> {
  const database = await openStateDatabase(databasePath);
  configureStateDatabase(database, busyTimeoutMs);
  database.exec("CREATE TABLE IF NOT EXISTS tack_job_leases (job_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, root_key TEXT NOT NULL DEFAULT 'root', nonce TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, fence TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','finished','cancelled','fenced')), deadline_ms INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER)");
  database.close();
}

export function coordinatorSchema(database: StateDatabase): void {
  configureStateDatabase(database, 5_000);
  database.exec("CREATE TABLE IF NOT EXISTS tack_job_leases (job_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, root_key TEXT NOT NULL DEFAULT 'root', nonce TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, fence TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','finished','cancelled','fenced')), deadline_ms INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER)");
}
