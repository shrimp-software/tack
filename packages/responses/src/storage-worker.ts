import { chmod, mkdir, open, realpath, rename, rm, lstat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { beginImmediate, commit, configureStateDatabase, openStateDatabase, rollback, type StateDatabase } from "@cbxss/tack-host-jobs";
import type { ResponseDescriptor } from "@cbxss/tack-core";

const databases = new Map<string, StateDatabase>();

interface PublishInput {
  readonly databasePath: string;
  readonly responsesRoot: string;
  readonly stagingRoot: string;
  readonly reservationId: string;
  readonly nonce: string;
  readonly ownerKey: string;
  readonly staging: string;
  readonly final: string;
  readonly serializedText: string;
  readonly metadataText: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly created: number;
  readonly expires: number;
  readonly fenceExpiresAt: number;
  readonly now: number;
  readonly clockOffset: number;
  readonly descriptor: ResponseDescriptor;
  readonly operationId: string | null;
  readonly callId: string | null;
  readonly executionId: string | null;
  readonly maxBytesPerOwner: number;
  readonly maxBytesPerRoot: number;
}

/** Trusted-host-only publication worker. SQLite transactions never span filesystem awaits. */
export async function publishResponse(input: PublishInput): Promise<ResponseDescriptor> {
  let database = databases.get(input.databasePath);
  if (!database) {
    database = await openStateDatabase(input.databasePath);
    configureStateDatabase(database, 5_000);
    initialize(database);
    databases.set(input.databasePath, database);
  }
  let published = false;
  let committed = false;
  let claimed = false;
  try {
    claimReservation(database, input);
    claimed = true;
    await ensureDirectory(input.staging);
    await assertDirectoryTree(input.staging, input.stagingRoot);
    await writeSynced(join(input.staging, "response.json"), input.serializedText);
    await writeSynced(join(input.staging, "metadata.json"), input.metadataText);
    await ensureDirectory(dirname(input.final));
    await assertDirectoryTree(dirname(input.final), input.responsesRoot);
    await rename(input.staging, input.final);
    published = true;
    await syncDirectory(dirname(input.final));
    commitPublication(database, input);
    committed = true;
    return input.descriptor;
  } catch (error) {
    if (!published && claimed) try { markFailed(database, input); } catch { /* preserve the original publication error */ }
    if (!published) await removeContainedDirectory(input.staging, input.stagingRoot, true).catch(() => undefined);
    // After final rename, retain the pair and publishing reservation for
    // recovery. A sync/commit/close/report error must not erase valid data.
    throw error;
  }
}

function claimReservation(database: StateDatabase, input: PublishInput): void {
  withImmediate(database, () => {
    const row = database.prepare("SELECT state, nonce, owner_key, fence_expires_at, max_bytes, created_at, expires_at FROM tack_response_reservations WHERE id = ?").get(input.reservationId) as Record<string, unknown> | undefined;
    if (!row || row.state !== "reserved" || row.nonce !== input.nonce || row.owner_key !== input.ownerKey || Number(row.fence_expires_at) <= fenceNow(input) || Number(row.max_bytes) < input.bytes || Number(row.created_at) !== input.created || Number(row.expires_at) !== input.expires) fail("response_reservation_fenced");
    database.prepare("UPDATE tack_response_reservations SET state = 'publishing' WHERE id = ? AND nonce = ? AND state = 'reserved'").run(input.reservationId, input.nonce);
  });
}

function commitPublication(database: StateDatabase, input: PublishInput): void {
  const charged = input.bytes + Buffer.byteLength(input.metadataText, "utf8");
  withImmediate(database, () => {
    const row = database.prepare("SELECT state, nonce, owner_key, fence_expires_at, max_bytes, created_at, expires_at FROM tack_response_reservations WHERE id = ?").get(input.reservationId) as Record<string, unknown> | undefined;
    if (!row || row.state !== "publishing" || row.nonce !== input.nonce || row.owner_key !== input.ownerKey || Number(row.fence_expires_at) <= fenceNow(input) || Number(row.max_bytes) < input.bytes || Number(row.created_at) !== input.created || Number(row.expires_at) !== input.expires) fail("response_reservation_fenced");
    const owner = publicationQuota(database, "owner", input.ownerKey, input.reservationId);
    const root = publicationQuota(database, "root", input.ownerKey, input.reservationId);
    if (owner.bytes + charged > input.maxBytesPerOwner || root.bytes + charged > input.maxBytesPerRoot) fail("response_quota_exceeded");
    database.prepare("INSERT INTO tack_responses (id, owner_key, bytes, charged_bytes, sha256, created_at, expires_at, state, operation_id, call_id, execution_id, descriptor_json, format_version) VALUES (?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?, 1)").run(input.reservationId, input.ownerKey, input.bytes, charged, input.sha256, input.created, input.expires, input.operationId, input.callId, input.executionId, JSON.stringify(input.descriptor));
    database.prepare("UPDATE tack_response_reservations SET state = 'committed' WHERE id = ? AND nonce = ? AND state = 'publishing'").run(input.reservationId, input.nonce);
  });
}

function markFailed(database: StateDatabase, input: PublishInput): void {
  withImmediate(database, () => { database.prepare("UPDATE tack_response_reservations SET state = 'failed' WHERE id = ? AND nonce = ? AND state IN ('reserved', 'publishing', 'recovering')").run(input.reservationId, input.nonce); });
}

function publicationQuota(database: StateDatabase, scope: "owner" | "root", key: string, excludeReservation: string): { bytes: number; count: number } {
  const ownerClause = scope === "owner" ? "owner_key = ?" : "1 = 1";
  const args = scope === "owner" ? [key] : [];
  const committed = database.prepare(`SELECT COALESCE(SUM(charged_bytes), 0) AS bytes, COUNT(*) AS count FROM tack_responses WHERE state IN ('committed', 'deleted', 'expired') AND charged_bytes > 0 AND ${ownerClause}`).get(...args) as Record<string, unknown>;
  const reserved = database.prepare(`SELECT COALESCE(SUM(max_bytes), 0) AS bytes, COUNT(*) AS count FROM tack_response_reservations WHERE state IN ('reserved', 'publishing', 'recovering') AND id != ? AND ${ownerClause}`).get(excludeReservation, ...args) as Record<string, unknown>;
  return { bytes: Number(committed?.bytes ?? 0) + Number(reserved?.bytes ?? 0), count: Number(committed?.count ?? 0) + Number(reserved?.count ?? 0) };
}

export async function runResponseOperation(input: Record<string, unknown>): Promise<unknown> {
  const databasePath = String(input.databasePath);
  let database = databases.get(databasePath);
  if (!database) {
    database = await openStateDatabase(databasePath);
    configureStateDatabase(database, 5_000);
    initialize(database);
    databases.set(databasePath, database);
  }
  switch (String(input.operation)) {
      case "init": return true;
      case "reserve": return storageTx(database, () => reserve(database, input));
      case "row": return database.prepare("SELECT id, owner_key, bytes, sha256, created_at, expires_at, state, operation_id, call_id, execution_id, descriptor_json, (SELECT provenance_json FROM tack_response_reservations WHERE id = tack_responses.id) AS provenance_json FROM tack_responses WHERE id = ?").get(String(input.id)) ?? null;
      case "list": return list(database, input);
      case "mark-delete": return storageTx(database, () => { database.prepare("UPDATE tack_responses SET state = 'deleted' WHERE id = ? AND owner_key = ? AND state = 'committed'").run(String(input.id), String(input.ownerKey)); return true; });
      case "charge-delete": return storageTx(database, () => { database.prepare("UPDATE tack_responses SET charged_bytes = 0 WHERE id = ? AND owner_key = ? AND state = 'deleted'").run(String(input.id), String(input.ownerKey)); return true; });
      case "prune-mark": return storageTx(database, () => { const rows = database.prepare("SELECT id, owner_key FROM tack_responses WHERE state IN ('committed', 'expired') AND expires_at <= ? AND charged_bytes > 0").all(Number(input.now)) as Array<Record<string, unknown>>; for (const row of rows) database.prepare("UPDATE tack_responses SET state = 'expired' WHERE id = ? AND state = 'committed'").run(String(row.id)); return rows; });
      case "prune-charge": return storageTx(database, () => { database.prepare("UPDATE tack_responses SET charged_bytes = 0 WHERE id = ?").run(String(input.id)); return true; });
      case "fail-reservation": return storageTx(database, () => { database.prepare("UPDATE tack_response_reservations SET state = 'failed' WHERE id = ? AND nonce = ? AND state IN ('reserved', 'publishing', 'recovering')").run(String(input.id), String(input.nonce)); return true; });
      case "expired-reservations": return database.prepare("SELECT * FROM tack_response_reservations WHERE state IN ('reserved', 'publishing', 'recovering') AND fence_expires_at <= ?").all(Number(input.now));
      case "recovery-claim": return storageTx(database, () => { const row = database.prepare("SELECT state, nonce, fence_expires_at FROM tack_response_reservations WHERE id = ?").get(String(input.id)) as Record<string, unknown> | undefined; if (!row || !["reserved", "publishing", "recovering"].includes(String(row.state)) || row.nonce !== String(input.nonce) || Number(row.fence_expires_at) > Number(input.now)) return false; database.prepare("UPDATE tack_response_reservations SET state = 'recovering' WHERE id = ? AND nonce = ? AND state IN ('reserved', 'publishing', 'recovering')").run(String(input.id), String(input.nonce)); return true; });
      case "recovery-reset": return storageTx(database, () => { database.prepare("UPDATE tack_response_reservations SET state = 'reserved' WHERE id = ? AND nonce = ? AND state = 'recovering'").run(String(input.id), String(input.nonce)); return true; });
      case "recovery-fail": return storageTx(database, () => { database.prepare("UPDATE tack_response_reservations SET state = 'failed' WHERE id = ? AND nonce = ? AND state = 'recovering'").run(String(input.id), String(input.nonce)); return true; });
      case "recovery-commit": return storageTx(database, () => { const owner = publicationQuota(database, "owner", String(input.owner), String(input.id)); const root = publicationQuota(database, "root", "root", String(input.id)); if (Number(input.bytes) > Number(input.reservationMaxBytes) || owner.bytes + Number(input.charged) > Number(input.maxBytesPerOwner) || root.bytes + Number(input.charged) > Number(input.maxBytesPerRoot)) fail("response_quota_exceeded"); database.prepare("INSERT OR IGNORE INTO tack_responses (id, owner_key, bytes, charged_bytes, sha256, created_at, expires_at, state, operation_id, call_id, execution_id, descriptor_json, format_version) VALUES (?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?, 1)").run(String(input.id), String(input.owner), Number(input.bytes), Number(input.charged), String(input.sha256), Number(input.created), Number(input.expires), input.operationId ?? null, input.callId ?? null, input.executionId ?? null, JSON.stringify(input.descriptor)); database.prepare("UPDATE tack_response_reservations SET state = 'committed' WHERE id = ? AND nonce = ? AND state = 'recovering'").run(String(input.id), String(input.nonce)); return true; });
      default: throw new Error("response_operation_unknown");
  }
}

function initialize(database: StateDatabase): void {
  database.exec(`CREATE TABLE IF NOT EXISTS tack_response_reservations (id TEXT PRIMARY KEY, nonce TEXT NOT NULL, owner_key TEXT NOT NULL, max_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, fence_expires_at INTEGER NOT NULL, state TEXT NOT NULL, operation_id TEXT, call_id TEXT, execution_id TEXT, provenance_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS tack_response_reservations_owner_idx ON tack_response_reservations(owner_key, state);
    CREATE TABLE IF NOT EXISTS tack_responses (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, bytes INTEGER NOT NULL, charged_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL, operation_id TEXT, call_id TEXT, execution_id TEXT, descriptor_json TEXT NOT NULL, format_version INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS tack_responses_owner_idx ON tack_responses(owner_key, state, created_at, id);
    CREATE INDEX IF NOT EXISTS tack_responses_execution_idx ON tack_responses(owner_key, execution_id, created_at, id);`);
  try { database.exec("ALTER TABLE tack_response_reservations ADD COLUMN fence_expires_at INTEGER NOT NULL DEFAULT 0"); } catch {}
}

function reserve(database: StateDatabase, input: Record<string, unknown>): Record<string, unknown> {
  const ownerKey = String(input.ownerKey); const bytes = Number(input.bytes); const owner = quota(database, "owner", ownerKey); const root = quota(database, "root", "root");
  if (owner.bytes + bytes > Number(input.maxBytesPerOwner) || root.bytes + bytes > Number(input.maxBytesPerRoot) || owner.count >= Number(input.maxResponsesPerOwner) || root.count >= Number(input.maxResponsesPerRoot)) fail("response_quota_exceeded");
  database.prepare("INSERT INTO tack_response_reservations (id, nonce, owner_key, max_bytes, created_at, expires_at, fence_expires_at, state, operation_id, call_id, execution_id, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)").run(String(input.id), String(input.nonce), ownerKey, bytes, Number(input.created), Number(input.expires), Number(input.fenceExpires), input.operationId ?? null, input.callId ?? null, input.executionId ?? null, String(input.provenanceJson));
  return { id: String(input.id), nonce: String(input.nonce), ownerKey, bytes, createdAt: new Date(Number(input.created)).toISOString(), expiresAt: new Date(Number(input.expires)).toISOString(), fenceExpiresAt: new Date(Number(input.fenceExpires)).toISOString() };
}

function list(database: StateDatabase, input: Record<string, unknown>): Array<Record<string, unknown>> {
  return database.prepare("SELECT id, owner_key, bytes, sha256, created_at, expires_at, state, operation_id, call_id, execution_id, descriptor_json, (SELECT provenance_json FROM tack_response_reservations WHERE id = tack_responses.id) AS provenance_json FROM tack_responses WHERE owner_key = ? AND state = 'committed' AND expires_at > ? AND created_at <= ? AND (created_at > ? OR (created_at = ? AND id > ?)) AND (? IS NULL OR execution_id = ?) ORDER BY created_at ASC, id ASC LIMIT ?").all(String(input.ownerKey), Number(input.now), Number(input.highWater), Number(input.created), Number(input.created), String(input.id), input.executionId ?? null, input.executionId ?? null, Number(input.limit)) as Array<Record<string, unknown>>;
}

function quota(database: StateDatabase, scope: "owner" | "root", key: string): { bytes: number; count: number } { const ownerClause = scope === "owner" ? "owner_key = ?" : "1 = 1"; const args = scope === "owner" ? [key] : []; const committed = database.prepare(`SELECT COALESCE(SUM(charged_bytes), 0) AS bytes, COUNT(*) AS count FROM tack_responses WHERE state IN ('committed', 'deleted', 'expired') AND charged_bytes > 0 AND ${ownerClause}`).get(...args) as Record<string, unknown>; const reserved = database.prepare(`SELECT COALESCE(SUM(max_bytes), 0) AS bytes, COUNT(*) AS count FROM tack_response_reservations WHERE state IN ('reserved', 'publishing', 'recovering') AND ${ownerClause}`).get(...args) as Record<string, unknown>; return { bytes: Number(committed?.bytes ?? 0) + Number(reserved?.bytes ?? 0), count: Number(committed?.count ?? 0) + Number(reserved?.count ?? 0) }; }
function storageTx<T>(database: StateDatabase, action: () => T): T { beginImmediate(database); try { const value = action(); commit(database); return value; } catch (error) { rollback(database); throw error; } }
function fenceNow(input: PublishInput): number { return Date.now() + input.clockOffset; }
function fail(code: string): never { throw new Error(code); }
function withImmediate<T>(database: StateDatabase, action: () => T): T { beginImmediate(database); try { const value = action(); commit(database); return value; } catch (error) { rollback(database); throw error; } }
async function ensureDirectory(path: string): Promise<void> { try { const info = await lstat(path); if (info.isSymbolicLink() || !info.isDirectory()) fail("response_directory_unsafe"); } catch (error) { const code = error && typeof error === "object" && "code" in error ? error.code : undefined; if (code !== "ENOENT") throw error; await mkdir(path, { recursive: true, mode: 0o700 }); } }
async function removeContainedDirectory(path: string, root: string, force: boolean): Promise<void> { const canonicalRoot = await realpath(root); const canonicalPath = await realpath(path); const rel = relative(canonicalRoot, canonicalPath); if (rel === ".." || rel.startsWith(`..${sep}`) || rel.includes(`${sep}..${sep}`)) fail("response_path_unsafe"); await rm(canonicalPath, { recursive: true, force }); }
async function assertDirectoryTree(path: string, root: string): Promise<void> { const rootInfo = await lstat(root); if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail("response_path_unsafe"); const rel = relative(root, path); if (rel === ".." || rel.startsWith(`..${sep}`) || rel.includes(`${sep}..${sep}`)) fail("response_path_unsafe"); let current = root; for (const segment of rel.split(sep).filter(Boolean)) { current = join(current, segment); const info = await lstat(current); if (info.isSymbolicLink() || !info.isDirectory()) fail("response_path_unsafe"); } }
async function writeSynced(path: string, text: string): Promise<void> { const handle = await open(path, "wx", 0o600); try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); } await chmod(path, 0o600); }
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }
