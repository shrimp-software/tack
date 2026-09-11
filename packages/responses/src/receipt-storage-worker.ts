import { createHash } from "node:crypto";
import { D08_LIMITS } from "@cbxss/tack-core";
import { beginImmediate, commit, configureStateDatabase, openStateDatabase, rollback, type StateDatabase } from "@cbxss/tack-host-jobs";

interface OperationInput { readonly databasePath: string; readonly operation: string; readonly [key: string]: unknown; }
const MAX_EXECUTION_BYTES = D08_LIMITS.maxReceiptBytesPerExecution;
const MAX_OWNER_BYTES = D08_LIMITS.maxReceiptBytesPerOwner;
const MAX_ROOT_BYTES = D08_LIMITS.maxReceiptBytesPerRoot;
const MAX_COUNT_OWNER = D08_LIMITS.maxReceiptCountPerOwner;
const MAX_EVENTS = D08_LIMITS.maxReceiptEvents;
const databases = new Map<string, StateDatabase>();

export async function runReceiptOperation(input: OperationInput): Promise<unknown> {
  let database = databases.get(input.databasePath);
  if (!database) {
    database = await openStateDatabase(input.databasePath);
    configureStateDatabase(database, 5_000);
    initialize(database);
    databases.set(input.databasePath, database);
  }
  switch (input.operation) {
      case "init": return true;
      case "start": return tx(database, () => start(database, input));
      case "get": return get(database, input);
      case "inspect": return inspect(database, input);
      case "list": return list(database, input);
      case "recipe": return tx(database, () => recipe(database, input));
      case "scan": return tx(database, () => scan(database, input));
      case "call": return tx(database, () => call(database, input));
      case "link": return tx(database, () => link(database, input));
      case "event": return tx(database, () => event(database, input));
      case "finish": return tx(database, () => finish(database, input));
      case "prune": return tx(database, () => prune(database, input));
      case "recover": return tx(database, () => recover(database, input));
      default: throw new Error("receipt_operation_unknown");
  }
}

function initialize(database: StateDatabase): void {
  database.exec(`CREATE TABLE IF NOT EXISTS tack_receipt_reservations (execution_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, max_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tack_executions (execution_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, host_instance_id TEXT NOT NULL, state TEXT NOT NULL, capture TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, deadline_ms INTEGER NOT NULL, expires_at INTEGER NOT NULL, catalog_revision TEXT, recipe_id TEXT, recipe_revision TEXT, reserved_bytes INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tack_receipt_recipes (run_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, recipe_id TEXT NOT NULL, program_sha256 TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, lock_sha256 TEXT NOT NULL, state TEXT NOT NULL, bytes INTEGER NOT NULL, recorded_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS tack_receipt_recipes_execution_idx ON tack_receipt_recipes(execution_id);
    CREATE TABLE IF NOT EXISTS tack_receipt_scans (scan_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, operation_id TEXT, evidence_json TEXT NOT NULL, bytes INTEGER NOT NULL, recorded_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS tack_receipt_scans_execution_idx ON tack_receipt_scans(execution_id);
    CREATE TABLE IF NOT EXISTS tack_receipt_calls (call_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, operation_id TEXT, schema_revision TEXT, input_validation TEXT NOT NULL, output_validation TEXT NOT NULL, upstream_outcome TEXT NOT NULL, delivery TEXT NOT NULL, duration_ms INTEGER, response_ids_json TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, recorded_at INTEGER NOT NULL DEFAULT 0, format_version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS tack_receipt_links (execution_id TEXT NOT NULL, response_id TEXT NOT NULL, relation TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, recorded_at INTEGER NOT NULL DEFAULT 0, format_version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (execution_id, response_id, relation));
    CREATE TABLE IF NOT EXISTS tack_receipt_events (execution_id TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL, code TEXT, message TEXT, bytes INTEGER NOT NULL, recorded_at INTEGER NOT NULL DEFAULT 0, format_version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (execution_id, sequence));
    CREATE INDEX IF NOT EXISTS tack_executions_owner_idx ON tack_executions(owner_key, started_at);
    CREATE INDEX IF NOT EXISTS tack_receipt_reservations_owner_idx ON tack_receipt_reservations(owner_key, state);`);
  try { database.exec("ALTER TABLE tack_executions ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 9223372036854775807"); } catch {}
  const callColumns = database.prepare("PRAGMA table_info(tack_receipt_calls)").all() as Array<{ name: string }>;
  if (!callColumns.some((column) => column.name === "recipe_run_id")) database.exec("ALTER TABLE tack_receipt_calls ADD COLUMN recipe_run_id TEXT");
  try { database.exec("ALTER TABLE tack_receipt_calls ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { database.exec("ALTER TABLE tack_receipt_links ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { database.exec("ALTER TABLE tack_receipt_calls ADD COLUMN recorded_at INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { database.exec("ALTER TABLE tack_receipt_calls ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1"); } catch {}
  try { database.exec("ALTER TABLE tack_receipt_links ADD COLUMN recorded_at INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { database.exec("ALTER TABLE tack_receipt_links ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1"); } catch {}
  try { database.exec("ALTER TABLE tack_receipt_events ADD COLUMN recorded_at INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { database.exec("ALTER TABLE tack_receipt_events ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1"); } catch {}
}

function start(database: StateDatabase, input: OperationInput): Record<string, unknown> {
  const owner = String(input.ownerKey); const executionId = String(input.executionId); const started = number(input.started); const expires = number(input.expires); const reserved = 64 * 1024;
  const ownerRow = database.prepare("SELECT COALESCE(SUM(reserved_bytes),0) AS bytes, COUNT(*) AS count FROM tack_executions WHERE owner_key = ?").get(owner) as Record<string, unknown>;
  const root = database.prepare("SELECT COALESCE(SUM(reserved_bytes),0) AS bytes FROM tack_executions").get() as Record<string, unknown>;
  if (Number(ownerRow.bytes ?? 0) + reserved > MAX_OWNER_BYTES || Number(root.bytes ?? 0) + reserved > MAX_ROOT_BYTES || Number(ownerRow.count ?? 0) >= MAX_COUNT_OWNER) fail("receipt_quota_exceeded");
  database.prepare("INSERT INTO tack_receipt_reservations (execution_id, owner_key, max_bytes, created_at, expires_at, state) VALUES (?, ?, ?, ?, ?, 'reserved')").run(executionId, owner, reserved, started, expires);
  database.prepare("INSERT INTO tack_executions (execution_id, owner_key, host_instance_id, state, capture, started_at, deadline_ms, expires_at, catalog_revision, recipe_id, recipe_revision, reserved_bytes) VALUES (?, ?, ?, 'running', 'complete', ?, ?, ?, ?, ?, ?, ?)").run(executionId, owner, String(input.hostInstanceId), started, started + number(input.deadlineMs), expires, input.catalogRevision ?? null, input.recipeId ?? null, input.recipeRevision ?? null, reserved);
  return getExecutionRow(database, executionId, owner);
}

function get(database: StateDatabase, input: OperationInput): { row?: Record<string, unknown>; operationIds: string[] } {
  const row = database.prepare("SELECT * FROM tack_executions WHERE execution_id = ? AND owner_key = ?").get(String(input.executionId), String(input.ownerKey)) as Record<string, unknown> | undefined;
  if (!row || Number(row.expires_at) <= number(input.now)) return { operationIds: [] };
  const operations = database.prepare("SELECT DISTINCT operation_id FROM tack_receipt_calls WHERE execution_id = ? AND operation_id IS NOT NULL AND upstream_outcome != 'not_started'").all(String(input.executionId)) as Array<Record<string, unknown>>;
  const scans = database.prepare("SELECT DISTINCT operation_id FROM tack_receipt_scans WHERE execution_id = ? AND operation_id IS NOT NULL").all(String(input.executionId)) as Array<Record<string, unknown>>;
  return { row, operationIds: [...new Set([...operations, ...scans].map((operation) => String(operation.operation_id)))] };
}

function list(database: StateDatabase, input: OperationInput): Record<string, unknown>[] {
  return database.prepare("SELECT execution_id, started_at FROM tack_executions WHERE owner_key = ? AND expires_at > ? AND started_at <= ? AND (started_at < ? OR (started_at = ? AND execution_id < ?)) ORDER BY started_at DESC, execution_id DESC LIMIT ?").all(String(input.ownerKey), number(input.now), number(input.highWater), number(input.beforeTime), number(input.beforeTime), String(input.beforeId), number(input.limit)) as Record<string, unknown>[];
}

function inspect(database: StateDatabase, input: OperationInput): Record<string, unknown> {
  const execution = requireExecution(database, input);
  const id = String(execution.execution_id); const limit = Math.min(1_000, number(input.limit));
  const calls = database.prepare("SELECT call_id, recipe_run_id, operation_id, schema_revision, input_validation, output_validation, upstream_outcome, delivery, duration_ms, response_ids_json, bytes, recorded_at, format_version FROM tack_receipt_calls WHERE execution_id = ? ORDER BY recorded_at ASC, call_id ASC").all(id) as Array<Record<string, unknown>>;
  const links = database.prepare("SELECT response_id, relation, bytes, recorded_at, format_version FROM tack_receipt_links WHERE execution_id = ? ORDER BY recorded_at ASC, response_id ASC").all(id) as Array<Record<string, unknown>>;
  const events = database.prepare("SELECT sequence, kind, code, bytes, recorded_at, format_version FROM tack_receipt_events WHERE execution_id = ? ORDER BY sequence ASC").all(id) as Array<Record<string, unknown>>;
  const scans = database.prepare("SELECT evidence_json, recorded_at FROM tack_receipt_scans WHERE execution_id = ? ORDER BY recorded_at, scan_id").all(id) as Array<Record<string, unknown>>;
  const recipes = database.prepare("SELECT run_id, recipe_id, program_sha256, manifest_sha256, lock_sha256, state, recorded_at FROM tack_receipt_recipes WHERE execution_id = ? ORDER BY recorded_at, run_id").all(id);
  const hasResponses = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tack_responses'").get();
  for (const link of links) {
    const response = hasResponses ? database.prepare("SELECT state, expires_at FROM tack_responses WHERE id = ? AND owner_key = ?").get(String(link.response_id), String(input.ownerKey)) as Record<string, unknown> | undefined : undefined;
    link.responseState = !response ? "unavailable" : response.state === "committed" && Number(response.expires_at) <= number(input.now) ? "expired" : response.state;
    link.integrity = "unchecked";
  }
  const collections = { calls, links, events, recipes, scans: scans.map((scan) => ({ ...JSON.parse(String(scan.evidence_json)), recordedAt: scan.recorded_at })) };
  const continuation = createHash("sha256").update(JSON.stringify([execution, collections])).digest("hex");
  const offset = number(input.offset ?? 0);
  if (offset && input.continuation !== continuation) fail("receipt_snapshot_changed");
  const totals = Object.fromEntries(Object.entries(collections).map(([key, rows]) => [key, rows.length]));
  let count = limit;
  while (count > 0) {
    const result = { formatVersion: 1, executionId: id, execution: { state: execution.state, capture: execution.capture, catalogRevision: execution.catalog_revision }, offset, continuation, totals, nextOffset: Math.max(...Object.values(totals)) > offset + count ? offset + count : null, ...Object.fromEntries(Object.entries(collections).map(([key, rows]) => [key, rows.slice(offset, offset + count)])) };
    if (Buffer.byteLength(JSON.stringify(result)) <= number(input.maxBytes)) return result;
    count = Math.floor(count / 2);
  }
  fail("receipt_page_too_large");
}

function recipe(database: StateDatabase, input: OperationInput): boolean {
  requireRunning(database, input);
  if (!["running", "completed", "partial", "failed"].includes(String(input.state))) fail("receipt_state_invalid");
  if (input.state === "running") database.prepare("INSERT INTO tack_receipt_recipes (run_id, execution_id, recipe_id, program_sha256, manifest_sha256, lock_sha256, state, bytes, recorded_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)").run(String(input.runId), String(input.executionId), String(input.recipeId), String(input.programSha256), String(input.manifestSha256), String(input.lockSha256), number(input.bytes), number(input.now));
  else {
    const existing = database.prepare("SELECT state FROM tack_receipt_recipes WHERE run_id = ? AND execution_id = ?").get(String(input.runId), String(input.executionId)) as Record<string, unknown> | undefined;
    if (!existing || existing.state !== "running") fail("receipt_terminal_mutation");
    database.prepare("UPDATE tack_receipt_recipes SET state = ?, bytes = ?, recorded_at = ? WHERE run_id = ? AND execution_id = ? AND state = 'running'").run(String(input.state), number(input.bytes), number(input.now), String(input.runId), String(input.executionId));
  }
  refresh(database, String(input.executionId));
  return true;
}

function scan(database: StateDatabase, input: OperationInput): boolean {
  requireRunning(database, input);
  database.prepare("INSERT INTO tack_receipt_scans (scan_id, execution_id, operation_id, evidence_json, bytes, recorded_at) VALUES (?, ?, ?, ?, ?, ?)").run(String(input.scanId), String(input.executionId), input.operationId ?? null, String(input.encoded), number(input.bytes), number(input.now));
  refresh(database, String(input.executionId));
  return true;
}

function call(database: StateDatabase, input: OperationInput): Record<string, unknown> {
  const execution = requireExecution(database, input);
  const callId = String(input.callId);
  const existing = database.prepare("SELECT call_id, operation_id, schema_revision, upstream_outcome, response_ids_json FROM tack_receipt_calls WHERE call_id = ? AND execution_id = ?").get(callId, execution.execution_id) as Record<string, unknown> | undefined;
  const responseIds = [...new Set([...(existing ? JSON.parse(String(existing.response_ids_json)) as string[] : []), ...(Array.isArray(input.responseIds) ? input.responseIds : [])])];
  const encoded = JSON.stringify(responseIds);
  if (existing) {
    if (["succeeded", "failed"].includes(String(existing.upstream_outcome)) && input.upstreamOutcome !== existing.upstream_outcome) fail("receipt_outcome_regression");
    if ((input.operationId !== undefined && input.operationId !== null && input.operationId !== existing.operation_id) || (input.schemaRevision !== undefined && input.schemaRevision !== null && input.schemaRevision !== existing.schema_revision)) fail("receipt_call_identity_mismatch");
    database.prepare("UPDATE tack_receipt_calls SET operation_id = ?, schema_revision = ?, input_validation = ?, output_validation = ?, upstream_outcome = ?, delivery = ?, duration_ms = ?, response_ids_json = ?, bytes = ?, recorded_at = ?, format_version = 1 WHERE call_id = ? AND execution_id = ?").run(existing.operation_id ?? null, existing.schema_revision ?? null, String(input.inputValidation), String(input.outputValidation), String(input.upstreamOutcome), String(input.delivery), input.durationMs ?? null, encoded, number(input.callBytes), number(input.now), callId, execution.execution_id);
  }
  else {
    if (String(execution.state) !== "running") fail("receipt_terminal_mutation");
    database.prepare("INSERT INTO tack_receipt_calls (call_id, execution_id, recipe_run_id, operation_id, schema_revision, input_validation, output_validation, upstream_outcome, delivery, duration_ms, response_ids_json, bytes, recorded_at, format_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(callId, execution.execution_id, input.recipeRunId ?? null, input.operationId ?? null, input.schemaRevision ?? null, String(input.inputValidation), String(input.outputValidation), String(input.upstreamOutcome), String(input.delivery), input.durationMs ?? null, encoded, number(input.callBytes), number(input.now), 1);
  }
  for (const responseId of responseIds) {
    const id = String(responseId); const bytes = Buffer.byteLength(JSON.stringify({ executionId: execution.execution_id, responseId: id, relation: "primary" }), "utf8");
    database.prepare("INSERT OR IGNORE INTO tack_receipt_links (execution_id, response_id, relation, bytes, recorded_at, format_version) VALUES (?, ?, 'primary', ?, ?, 1)").run(execution.execution_id, id, bytes, number(input.now));
  }
  refresh(database, String(execution.execution_id));
  return {};
}

function link(database: StateDatabase, input: OperationInput): Record<string, unknown> {
  const execution = requireRunning(database, input);
  database.prepare("INSERT OR IGNORE INTO tack_receipt_links (execution_id, response_id, relation, bytes, recorded_at, format_version) VALUES (?, ?, ?, ?, ?, 1)").run(execution.execution_id, String(input.responseId), String(input.relation), number(input.bytes), number(input.now));
  refresh(database, String(execution.execution_id));
  return {};
}

function event(database: StateDatabase, input: OperationInput): Record<string, unknown> {
  const execution = requireRunning(database, input);
  if (input.kind === "capture_gap") database.prepare("UPDATE tack_executions SET capture = 'incomplete' WHERE execution_id = ?").run(execution.execution_id);
  const count = database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM tack_receipt_events WHERE execution_id = ?").get(execution.execution_id) as Record<string, unknown>;
  const sequence = Number(count.count ?? 0); const bytes = number(input.bytes);
  if (sequence >= MAX_EVENTS || Number(count.bytes ?? 0) + bytes > MAX_EXECUTION_BYTES) {
    database.prepare("UPDATE tack_executions SET capture = 'incomplete' WHERE execution_id = ?").run(execution.execution_id);
    return { executionId: execution.execution_id, sequence, kind: "capture_gap", code: "receipt_event_limit", message: "receipt event capture limit reached" };
  }
  database.prepare("INSERT INTO tack_receipt_events (execution_id, sequence, kind, code, message, bytes, recorded_at, format_version) VALUES (?, ?, ?, ?, NULL, ?, ?, 1)").run(execution.execution_id, sequence, String(input.kind), input.code ?? null, bytes, number(input.now));
  refresh(database, String(execution.execution_id));
  return { executionId: execution.execution_id, sequence, kind: String(input.kind), ...(input.code ? { code: String(input.code) } : {}) };
}

function finish(database: StateDatabase, input: OperationInput): Record<string, unknown> {
  const execution = requireRunning(database, input);
  if (!["completed", "failed", "cancelled"].includes(String(input.state))) fail("receipt_state_invalid");
  database.prepare("UPDATE tack_executions SET state = ?, ended_at = ? WHERE execution_id = ? AND state = 'running'").run(String(input.state), number(input.ended), execution.execution_id);
  refresh(database, String(execution.execution_id));
  const actual = receiptBytes(database, String(execution.execution_id));
  database.prepare("UPDATE tack_executions SET reserved_bytes = MAX(4096, ?) WHERE execution_id = ?").run(actual, execution.execution_id);
  database.prepare("UPDATE tack_receipt_reservations SET state = 'committed' WHERE execution_id = ? AND state = 'reserved'").run(execution.execution_id);
  return getExecutionRow(database, String(execution.execution_id), String(input.ownerKey));
}

function prune(database: StateDatabase, input: OperationInput): number {
  const rows = database.prepare("SELECT execution_id FROM tack_executions WHERE expires_at <= ?").all(number(input.now)) as Array<Record<string, unknown>>;
  for (const row of rows) { const id = String(row.execution_id); database.prepare("DELETE FROM tack_receipt_recipes WHERE execution_id = ?").run(id); database.prepare("DELETE FROM tack_receipt_scans WHERE execution_id = ?").run(id); database.prepare("DELETE FROM tack_receipt_events WHERE execution_id = ?").run(id); database.prepare("DELETE FROM tack_receipt_calls WHERE execution_id = ?").run(id); database.prepare("DELETE FROM tack_receipt_links WHERE execution_id = ?").run(id); database.prepare("DELETE FROM tack_receipt_reservations WHERE execution_id = ?").run(id); database.prepare("DELETE FROM tack_executions WHERE execution_id = ? AND expires_at <= ?").run(id, number(input.now)); }
  return rows.length;
}

function recover(database: StateDatabase, input: OperationInput): number {
  const host = input.hostInstanceId === null ? undefined : String(input.hostInstanceId);
  const rows = (host
    ? database.prepare("SELECT execution_id FROM tack_executions WHERE host_instance_id = ? AND state = 'running'").all(host)
    : database.prepare("SELECT execution_id FROM tack_executions WHERE state = 'running' AND deadline_ms <= ?").all(number(input.expiredBefore))) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const id = String(row.execution_id);
    database.prepare("UPDATE tack_receipt_recipes SET state = 'interrupted' WHERE execution_id = ? AND state = 'running'").run(id);
    database.prepare("UPDATE tack_executions SET state = 'interrupted', ended_at = ?, capture = 'incomplete', reserved_bytes = ? WHERE execution_id = ? AND state = 'running'").run(number(input.now), receiptBytes(database, id), id);
    database.prepare("UPDATE tack_receipt_reservations SET state = 'committed' WHERE execution_id = ? AND state = 'reserved'").run(id);
  }
  return rows.length;
}

function requireExecution(database: StateDatabase, input: OperationInput): Record<string, unknown> { const row = database.prepare("SELECT * FROM tack_executions WHERE execution_id = ? AND owner_key = ?").get(String(input.executionId), String(input.ownerKey)) as Record<string, unknown> | undefined; if (!row || Number(row.expires_at) <= number(input.now)) fail("receipt_not_found"); return row; }
function requireRunning(database: StateDatabase, input: OperationInput): Record<string, unknown> { const row = requireExecution(database, input); if (String(row.state) !== "running") fail("receipt_terminal_mutation"); return row; }
function getExecutionRow(database: StateDatabase, id: string, owner: string): Record<string, unknown> { return database.prepare("SELECT * FROM tack_executions WHERE execution_id = ? AND owner_key = ?").get(id, owner) as Record<string, unknown>; }
function refresh(database: StateDatabase, id: string): void {
  const actual = receiptBytes(database, id);
  if (actual > MAX_EXECUTION_BYTES) fail("receipt_quota_exceeded");
  const row = database.prepare("SELECT owner_key, reserved_bytes FROM tack_executions WHERE execution_id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) fail("receipt_not_found");
  const owner = database.prepare("SELECT COALESCE(SUM(reserved_bytes),0) AS bytes FROM tack_executions WHERE owner_key = ?").get(String(row.owner_key)) as Record<string, unknown>;
  const root = database.prepare("SELECT COALESCE(SUM(reserved_bytes),0) AS bytes FROM tack_executions").get() as Record<string, unknown>;
  if (Number(owner.bytes ?? 0) - Number(row.reserved_bytes ?? 0) + actual > MAX_OWNER_BYTES || Number(root.bytes ?? 0) - Number(row.reserved_bytes ?? 0) + actual > MAX_ROOT_BYTES) fail("receipt_quota_exceeded");
  database.prepare("UPDATE tack_executions SET reserved_bytes = MAX(reserved_bytes, ?) WHERE execution_id = ?").run(actual, id);
}
function receiptBytes(database: StateDatabase, id: string): number { const c = database.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM tack_receipt_calls WHERE execution_id = ?").get(id) as Record<string, unknown>; const l = database.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM tack_receipt_links WHERE execution_id = ?").get(id) as Record<string, unknown>; const e = database.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM tack_receipt_events WHERE execution_id = ?").get(id) as Record<string, unknown>; const s = database.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM tack_receipt_scans WHERE execution_id = ?").get(id) as Record<string, unknown>; const r = database.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM tack_receipt_recipes WHERE execution_id = ?").get(id) as Record<string, unknown>; return 4096 + Number(r.n ?? 0) + Number(c.n ?? 0) + Number(l.n ?? 0) + Number(e.n ?? 0) + Number(s.n ?? 0); }
function number(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) fail("receipt_value_invalid"); return value; }
function fail(code: string): never { throw new Error(code); }
function tx<T>(database: StateDatabase, action: () => T): T { beginImmediate(database); try { const value = action(); commit(database); return value; } catch (error) { rollback(database); throw error; } }
