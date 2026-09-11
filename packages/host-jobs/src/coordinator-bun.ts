import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

const scope = globalThis as unknown as { onmessage: ((event: { readonly data: { id?: number; operation: string; input: any } }) => void) | null; postMessage(value: unknown): void };
let database: Database | undefined;
let busyTimeoutMs = 5_000;
let initialization: Promise<void> | undefined;
scope.onmessage = (event) => { void handle(event); };

async function handle(event: { readonly data: { id?: number; operation: string; input: any } }): Promise<void> {
  try {
    const message = event.data;
    if (message.operation === "init") {
      initialization = initialize(message.input);
      await initialization;
      return;
    }
    if (initialization) await initialization;
    if (!database) throw new Error("job_coordinator_database_missing");
    let value: unknown;
    if (message.operation === "ready") value = true;
    else if (message.operation === "acquire") value = acquire(message.input);
    else if (message.operation === "current") value = current(message.input);
    else if (message.operation === "release") value = release(message.input);
    else throw new Error("job_coordinator_operation_unknown");
    scope.postMessage({ id: message.id, ok: true, value });
  } catch (error) { scope.postMessage({ id: event.data.id, ok: false, error: error instanceof Error ? error.message : "job_coordinator_error" }); }
}

async function initialize(input: any): Promise<void> {
  busyTimeoutMs = Number(input?.limits?.busyTimeoutMs ?? 5_000);
  database = new Database(input?.databasePath ?? "");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      database.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs}; CREATE TABLE IF NOT EXISTS tack_job_leases (job_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, root_key TEXT NOT NULL DEFAULT 'root', nonce TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, fence TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','finished','cancelled','fenced')), deadline_ms INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER)`);
      return;
    } catch (error) { if (attempt === 19) throw error; await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
}

function tx<T>(run: () => T): T { if (!database) throw new Error("job_coordinator_database_missing"); database.exec("BEGIN IMMEDIATE"); try { const value = run(); database.exec("COMMIT"); return value; } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; } }
function acquire(input: any): unknown { if (Date.now() >= input.deadline) return undefined; return tx(() => { database!.query("DELETE FROM tack_job_leases WHERE state IN ('active','fenced','cancelled') AND deadline_ms <= ?").run(Date.now()); const root = database!.query("SELECT COUNT(*) AS count FROM tack_job_leases WHERE state = 'active' AND root_key = ?").get(input.rootKey) as any; const owner = database!.query("SELECT COUNT(*) AS count FROM tack_job_leases WHERE state = 'active' AND root_key = ? AND owner_key = ?").get(input.rootKey, input.ownerKey) as any; if (Number(root?.count ?? 0) >= input.limits.maxRootConcurrent || Number(owner?.count ?? 0) >= input.limits.maxOwnerConcurrent) return undefined; const fence = randomUUID(); database!.query("INSERT INTO tack_job_leases (job_id, owner_key, root_key, nonce, kind, fence, state, deadline_ms, started_at) VALUES (?, ?, ?, ?, 'bounded', ?, 'active', ?, ?)").run(input.jobId, input.ownerKey, input.rootKey, input.nonce, fence, input.deadline, Date.now()); return { ...input, fence }; }); }
function current(input: any): boolean { const row = database!.query("SELECT state, fence, nonce, owner_key, root_key, deadline_ms FROM tack_job_leases WHERE job_id = ?").get(input.lease.jobId) as any; return Date.now() < input.deadline && row?.state === "active" && row.fence === input.lease.fence && row.nonce === input.lease.nonce && row.owner_key === input.lease.ownerKey && row.root_key === input.lease.rootKey && Number(row.deadline_ms) > Date.now(); }
function release(input: any): boolean { return tx(() => { const state = Date.now() >= input.deadline ? "fenced" : input.state; const result = database!.query("UPDATE tack_job_leases SET state = ?, finished_at = ? WHERE job_id = ? AND owner_key = ? AND root_key = ? AND nonce = ? AND fence = ? AND state = 'active'").run(state, Date.now(), input.lease.jobId, input.lease.ownerKey, input.lease.rootKey, input.lease.nonce, input.lease.fence) as any; return Number(result?.changes ?? 0) > 0; }); }
