import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("job_coordinator_parent_missing");
const config = workerData as { databasePath: string; limits: { maxRootConcurrent: number; maxOwnerConcurrent: number; busyTimeoutMs: number } };
const database = new DatabaseSync(config.databasePath);
for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    database.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${config.limits.busyTimeoutMs}; CREATE TABLE IF NOT EXISTS tack_job_leases (job_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, root_key TEXT NOT NULL DEFAULT 'root', nonce TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, fence TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','finished','cancelled','fenced')), deadline_ms INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER)`);
    break;
  } catch (error) { if (attempt === 19) throw error; await new Promise((resolve) => setTimeout(resolve, 25)); }
}

parentPort.on("message", (message: { id: number; operation: string; input: any }) => {
  try {
    let value: unknown;
    if (message.operation === "ready") value = true;
    else if (message.operation === "acquire") value = acquire(message.input);
    else if (message.operation === "current") value = current(message.input);
    else if (message.operation === "release") value = release(message.input);
    else throw new Error("job_coordinator_operation_unknown");
    parentPort?.postMessage({ id: message.id, ok: true, value });
  } catch (error) { parentPort?.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : "job_coordinator_error" }); }
});

function tx<T>(run: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const value = run(); database.exec("COMMIT"); return value; } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; } }
function acquire(input: { jobId: string; ownerKey: string; rootKey: string; nonce: string; deadline: number }): unknown {
  if (Date.now() >= input.deadline) return undefined;
  return tx(() => {
    const now = Date.now();
    database.prepare("DELETE FROM tack_job_leases WHERE state IN ('active','fenced','cancelled') AND deadline_ms <= ?").run(now);
    const root = database.prepare("SELECT COUNT(*) AS count FROM tack_job_leases WHERE state = 'active' AND root_key = ?").get(input.rootKey) as any;
    const owner = database.prepare("SELECT COUNT(*) AS count FROM tack_job_leases WHERE state = 'active' AND root_key = ? AND owner_key = ?").get(input.rootKey, input.ownerKey) as any;
    if (Number(root?.count ?? 0) >= config.limits.maxRootConcurrent || Number(owner?.count ?? 0) >= config.limits.maxOwnerConcurrent) return undefined;
    const fence = randomUUID();
    database.prepare("INSERT INTO tack_job_leases (job_id, owner_key, root_key, nonce, kind, fence, state, deadline_ms, started_at) VALUES (?, ?, ?, ?, 'bounded', ?, 'active', ?, ?)").run(input.jobId, input.ownerKey, input.rootKey, input.nonce, fence, input.deadline, now);
    return { ...input, fence };
  });
}
function current(input: { lease: { jobId: string; ownerKey: string; rootKey: string; nonce: string; fence: string }; deadline: number }): boolean {
  const row = database.prepare("SELECT state, fence, nonce, owner_key, root_key, deadline_ms FROM tack_job_leases WHERE job_id = ?").get(input.lease.jobId) as any;
  return Date.now() < input.deadline && row?.state === "active" && row.fence === input.lease.fence && row.nonce === input.lease.nonce && row.owner_key === input.lease.ownerKey && row.root_key === input.lease.rootKey && Number(row.deadline_ms) > Date.now();
}
function release(input: { lease: { jobId: string; ownerKey: string; rootKey: string; nonce: string; fence: string }; state: string; deadline: number }): boolean {
  return tx(() => { const state = Date.now() >= input.deadline ? "fenced" : input.state; const result = database.prepare("UPDATE tack_job_leases SET state = ?, finished_at = ? WHERE job_id = ? AND owner_key = ? AND root_key = ? AND nonce = ? AND fence = ? AND state = 'active'").run(state, Date.now(), input.lease.jobId, input.lease.ownerKey, input.lease.rootKey, input.lease.nonce, input.lease.fence) as { changes?: unknown }; return Number(result.changes ?? 0) > 0; });
}
