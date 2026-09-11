import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename, rm, lstat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  responseShapeSchema, type ResponseShape,
  CONTRACT_LIMITS, canonicalJson, validateScanSpec, validateScanCoverage, type ScanSpec, type ScanCoverage,
  validateReadPage,
  validateResponseDescriptor,
  principalOwnerKey,
  type Principal,
  type ReadPage,
  type ResponseDescriptor
} from "@cbxss/tack-core";
import {
  createBoundedJobPool,
  type BoundedJobPool,
  type JobResult
} from "@cbxss/tack-host-jobs";
import { makeShapePreview, serializeJson, serializeNormalizedEnvelope, shapeOf, type NormalizedResponseEnvelope } from "./serialization.js";

export interface ResponseStoreLimits {
  readonly previewMaxBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxReadBytes?: number;
  readonly maxBytesPerOwner?: number;
  readonly maxBytesPerRoot?: number;
  readonly maxResponsesPerOwner?: number;
  readonly maxResponsesPerRoot?: number;
  readonly retentionMs?: number;
  readonly busyTimeoutMs?: number;
  readonly readJobMs?: number;
}

export interface ResponseStoreOptions {
  readonly root: string;
  /** Workspace UUID loaded by trusted host composition, never supplied by agent code. */
  readonly workspaceId: string;
  readonly limits?: ResponseStoreLimits;
  readonly now?: () => number;
  readonly policy?: ResponsePolicy;
  /** Borrow the host governor; the store never closes a borrowed pool. */
  readonly jobs?: BoundedJobPool;
}

export interface ResponsePolicy {
  /** Current operation authorization; a false result is indistinguishable from missing. */
  authorizeOrigin?(operationId: string | null, principal: Principal, action: "read" | "describe" | "list" | "delete" | "path"): boolean | Promise<boolean>;
  /** Current ledger/binding availability for the originating identity. */
  isOriginActive?(operationId: string): boolean | Promise<boolean>;
  /** Explicit exact-ID archive grant. It must never override an explicit deny. */
  allowRetainedOrigin?(operationId: string, principal: Principal): boolean | Promise<boolean>;
  isOriginDenied?(operationId: string, principal: Principal): boolean | Promise<boolean>;
}

export interface ResponseProvenance {
  readonly operationId?: string;
  readonly callId?: string;
  readonly executionId?: string;
  readonly derived?: DerivedProvenance;
  readonly expiresAt?: string;
  readonly upstreamOutcome?: "not_started" | "succeeded" | "failed" | "unknown";
  readonly upstreamCompleteness?: "unknown" | "partial" | "complete";
  readonly validation?: unknown;
}

export interface DerivedProvenance {
  readonly parentId: string; readonly parentSha256: string; readonly pointer: string;
  readonly spec: ScanSpec; readonly specHash: string; readonly coverage: ScanCoverage;
}
export interface ScanOptions { readonly id: string; readonly pointer?: string; readonly spec: unknown; readonly offset?: number; readonly limit?: number; readonly response?: "auto" | "inline" | "store"; readonly maxBytes?: number; readonly executionId?: string; readonly signal?: AbortSignal; }
export interface ScanResult { readonly ok: true; readonly scanId: string; readonly delivery: "inline" | "stored"; readonly data?: unknown; readonly response?: ResponseDescriptor; readonly numericCount: number; readonly provenance: DerivedProvenance; }

export interface ResponseReservation {
  readonly id: string;
  readonly nonce: string;
  readonly ownerKey: string;
  readonly bytes: number;
  readonly expiresAt: string;
  readonly fenceExpiresAt: string;
  readonly createdAt: string;
}

export interface ResponseRecord {
  readonly descriptor: ResponseDescriptor;
  readonly ownerKey: string;
  readonly operationId: string | null;
  readonly callId: string | null;
  readonly executionId: string | null;
  readonly derived?: DerivedProvenance;
  readonly state: "committed" | "deleted" | "expired" | "corrupt";
}

export interface ListResponsesOptions {
  readonly principal: Principal;
  readonly executionId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListedResponses {
  readonly records: readonly ResponseRecord[];
  readonly nextCursor: string | null;
}

export class ResponseBackendError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "ResponseBackendError"; }
}

export const RESPONSE_JOB_HANDLERS = {
  "responses.shape": { module: new URL("./read-worker.js", import.meta.url), exportName: "describeStoredValue" },
  "responses.verify": { module: new URL("./read-worker.js", import.meta.url), exportName: "verifyStoredResponse" },
  "responses.scan": { module: new URL("./scan-worker.js", import.meta.url), exportName: "scanResponse" },
  "responses.read": { module: new URL("./read-worker.js", import.meta.url), exportName: "readResponsePage" },
  "responses.publish": { module: new URL("./storage-worker.js", import.meta.url), exportName: "publishResponse" },
  "responses.storage": { module: new URL("./storage-worker.js", import.meta.url), exportName: "runResponseOperation" }
} as const;

const RESPONSE_ID = /^resp_[0-9a-f-]{20,80}$/u;
const DEFAULTS = {
  maxResponseBytes: CONTRACT_LIMITS.maxStoredResponseBytes,
  maxReadBytes: CONTRACT_LIMITS.pageBytes,
  previewMaxBytes: 2 * 1024,
  maxBytesPerOwner: CONTRACT_LIMITS.maxPayloadBytesPerOwner,
  maxBytesPerRoot: CONTRACT_LIMITS.maxPayloadBytesPerRoot,
  maxResponsesPerOwner: CONTRACT_LIMITS.maxResponsesPerOwner,
  maxResponsesPerRoot: CONTRACT_LIMITS.maxResponsesPerRoot,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  busyTimeoutMs: 5_000,
  readJobMs: 5_000
} as const;

export function deriveOwnerKey(workspaceId: string, principal: Principal): string {
  if (!workspaceId || principal.workspaceId !== workspaceId) throw new ResponseBackendError("principal_workspace_mismatch");
  return principalOwnerKey(principal);
}

export async function createResponseStore(options: ResponseStoreOptions): Promise<ResponseStore> {
  return ResponseStore.open(options);
}

export class ResponseStore {
  private constructor(
    private readonly options: ResponseStoreOptions,
    private readonly limits: Required<ResponseStoreLimits>,
    private readonly jobs: BoundedJobPool,
    private readonly tackRoot: string,
    private readonly responsesRoot: string,
    private readonly stagingRoot: string,
    private readonly ownsJobs: boolean
  ) {}

  static async open(options: ResponseStoreOptions): Promise<ResponseStore> {
    if (!options.root || !options.workspaceId) throw new ResponseBackendError("response_store_config_invalid");
    const limits = normalizeLimits(options.limits);
    if (limits.retentionMs > 30 * 24 * 60 * 60 * 1000) throw new ResponseBackendError("response_retention_exceeds_cap");
    const tackRoot = join(options.root, ".tack");
    const responsesRoot = join(tackRoot, "responses");
    const stagingRoot = join(tackRoot, "staging");
    await ensureDirectory(tackRoot);
    await ensureDirectory(responsesRoot);
    await ensureDirectory(stagingRoot);
    const jobs = options.jobs ?? await createBoundedJobPool({ root: options.root, databasePath: join(tackRoot, "state.sqlite"), limits: { maxJobMs: limits.readJobMs, maxInputBytes: 32 * 1024 * 1024 }, handlers: RESPONSE_JOB_HANDLERS });
    const store = new ResponseStore(options, limits, jobs, tackRoot, responsesRoot, stagingRoot, options.jobs === undefined);
    try {
      await store.operation({ operation: "init" }, "response-maintenance");
      await store.recoverExpired();
    } catch (error) { await store.close(); throw error; }
    return store;
  }

  async close(): Promise<void> {
    if (this.ownsJobs) await this.jobs.close();
  }

  ownerKey(principal: Principal): string { return deriveOwnerKey(this.options.workspaceId, principal); }

  async reserve(principal: Principal, bytes: number, provenance: ResponseProvenance): Promise<ResponseReservation> {
    const ownerKey = this.ownerKey(principal);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.limits.maxResponseBytes) throw new ResponseBackendError("response_too_large");
    const id = `resp_${randomUUID()}`;
    const nonce = randomUUID();
    const created = this.now();
    const parent = provenance.derived ? await this.authorizedRow(principal, provenance.derived.parentId, "read", 1) : undefined;
    if (parent && parent.descriptor.sha256 !== provenance.derived!.parentSha256) throw new ResponseBackendError("response_not_found");
    const expires = Math.min(created + this.limits.retentionMs, parent ? Date.parse(parent.descriptor.expiresAt) : Infinity);
    const fenceExpires = created + 30_000;
    return await this.operation({ operation: "reserve", id, nonce, ownerKey, bytes, created, expires, fenceExpires, operationId: provenance.operationId ?? null, callId: provenance.callId ?? null, executionId: provenance.executionId ?? null, provenanceJson: boundedProvenance(provenance), maxBytesPerOwner: this.limits.maxBytesPerOwner, maxBytesPerRoot: this.limits.maxBytesPerRoot, maxResponsesPerOwner: this.limits.maxResponsesPerOwner, maxResponsesPerRoot: this.limits.maxResponsesPerRoot }, ownerKey) as ResponseReservation;
  }

  /** Serializes before reservation publication; callers should reserve after normalization and before upstream invocation when possible. */
  async retain(principal: Principal, envelope: NormalizedResponseEnvelope, provenance: ResponseProvenance): Promise<ResponseDescriptor> {
    let serialized;
    try { serialized = serializeNormalizedEnvelope(envelope, { maxBytes: this.limits.maxResponseBytes }); }
    catch (error) { throw new ResponseBackendError(error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "response_unserializable", error instanceof Error ? error.message : "response could not be serialized"); }
    const reservation = await this.reserve(principal, serialized.bytes, provenance);
    try { return await this.publishSerialized(principal, reservation, envelope, serialized, provenance); }
    catch (error) {
      await this.failReservation(reservation).catch(() => undefined);
      throw error;
    }
  }

  async publish(principal: Principal, reservation: ResponseReservation, envelope: NormalizedResponseEnvelope, provenance: ResponseProvenance): Promise<ResponseDescriptor> {
    const serialized = serializeNormalizedEnvelope(envelope, { maxBytes: this.limits.maxResponseBytes });
    return this.publishSerialized(principal, reservation, envelope, serialized, provenance);
  }

  private async publishSerialized(principal: Principal, reservation: ResponseReservation, envelope: NormalizedResponseEnvelope, serialized: { text: string; bytes: number; sha256: string; rootShape: ResponseDescriptor["rootShape"]; normalized: NormalizedResponseEnvelope }, provenance: ResponseProvenance): Promise<ResponseDescriptor> {
    if (reservation.ownerKey !== this.ownerKey(principal) || serialized.bytes > reservation.bytes) throw new ResponseBackendError("response_reservation_invalid");
    const created = this.parseTime(reservation.createdAt);
    const expires = this.parseTime(reservation.expiresAt);
    const preview = makeShapePreview(serialized.normalized.data, this.limits.previewMaxBytes);
    const descriptor = descriptorFor(reservation.id, serialized, created, expires, provenance, preview);
    if (Buffer.byteLength(serializeJson(descriptor), "utf8") > CONTRACT_LIMITS.descriptorBytes) throw new ResponseBackendError("response_descriptor_too_large");
    const staging = join(this.stagingRoot, `${reservation.id}-${reservation.nonce}`);
    const final = this.finalPath(reservation.ownerKey, reservation.id);
    await ensureDirectory(staging);
    const metadataText = serializeJson(metadataFor(reservation, descriptor, provenance));
    const result = await this.jobs.submit({
      kind: "response-publish",
      ownerKey: reservation.ownerKey,
      handler: "responses.publish",
      deadlineMs: this.limits.readJobMs,
      input: {
        databasePath: join(this.tackRoot, "state.sqlite"), responsesRoot: this.responsesRoot, stagingRoot: this.stagingRoot,
        reservationId: reservation.id, nonce: reservation.nonce, ownerKey: reservation.ownerKey,
        staging, final, serializedText: serialized.text, metadataText, bytes: serialized.bytes, sha256: serialized.sha256,
        created, expires, fenceExpiresAt: this.parseTime(reservation.fenceExpiresAt), now: this.now(), clockOffset: this.now() - Date.now(), descriptor, operationId: provenance.operationId ?? null, callId: provenance.callId ?? null,
        executionId: provenance.executionId ?? null, maxBytesPerOwner: this.limits.maxBytesPerOwner, maxBytesPerRoot: this.limits.maxBytesPerRoot
      }
    });
    if (!result.ok) {
      const code = result.code === "job_handler_error" && /^response_[a-z_]+(?::|$)/u.test(result.message) ? (result.message.split(":", 1)[0] ?? "response_persistence_failed") : result.code === "job_timeout" ? "response_storage_timeout" : "response_persistence_failed";
      throw new ResponseBackendError(code, result.message);
    }
    return result.value as ResponseDescriptor;
  }

  async scan(principal: Principal, input: ScanOptions): Promise<ScanResult> {
    const started = Date.now();
    let spec: ScanSpec;
    try { spec = validateScanSpec(input.spec); } catch { throw new ResponseBackendError("scan_spec_invalid"); }
    const offset = input.offset ?? 0, limit = input.limit ?? 100_000;
    const pointer = input.pointer ?? "";
    const mode = input.response ?? "auto";
    const maxBytes = Math.min(input.maxBytes ?? this.limits.maxReadBytes, this.limits.maxReadBytes);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 8192 || pointer.length > 512 || !["auto", "inline", "store"].includes(mode)) throw new ResponseBackendError("scan_options_invalid");
    input.signal?.throwIfAborted();
    const parent = await this.authorizedRow(principal, input.id, "read");
    const file = this.responsePath(parent.ownerKey, input.id);
    await assertRegularContained(file, this.responsesRoot);
    const remaining = this.limits.readJobMs - (Date.now() - started);
    if (remaining <= 0) throw new ResponseBackendError("scan_timeout");
    const result = await this.jobs.submit({ kind: "response-read", ownerKey: parent.ownerKey, handler: "responses.scan", ...(input.signal ? { signal: input.signal } : {}), deadlineMs: remaining, input: { path: file, sha256: parent.descriptor.sha256, pointer, spec, offset, limit, maxBytes: (mode === "inline" ? maxBytes : this.limits.maxResponseBytes) - 8192, stopReason: mode === "inline" ? "output_limit" : "artifact_limit", deadlineAtMs: started + this.limits.readJobMs - 25 } });
    if (!result.ok) throw new ResponseBackendError(result.code === "job_handler_error" && /^(scan_|response_)[a-z_]+(?::|$)/u.test(result.message) ? result.message.split(":", 1)[0]! : result.code === "job_timeout" ? "scan_timeout" : "scan_failed");
    const scanned = result.value as import("./scan-worker.js").ScanWorkerResult;
    validateScanCoverage(scanned.coverage, { offset });
    const provenance: DerivedProvenance = { parentId: input.id, parentSha256: parent.descriptor.sha256, pointer, spec, specHash: createHash("sha256").update(canonicalJson(spec)).digest("hex"), coverage: scanned.coverage };
    const scanId = `scan_${randomUUID()}`;
    const inline: ScanResult = { ok: true, scanId, delivery: "inline", data: scanned.data, numericCount: scanned.numericCount, provenance };
    await this.authorizedRow(principal, input.id, "read");
    input.signal?.throwIfAborted();
    if (mode !== "store" && Buffer.byteLength(serializeJson(inline)) <= maxBytes) return inline;
    if (mode === "inline") throw new ResponseBackendError("response_element_too_large");
    const descriptor = await this.retain(principal, { formatVersion: 1, kind: "derived-result", data: scanned.data, text: "", provenance }, { derived: provenance, ...(parent.operationId ? { operationId: parent.operationId } : {}), ...(input.executionId ? { executionId: input.executionId } : {}), upstreamCompleteness: parent.descriptor.upstreamCompleteness });
    await this.authorizedRow(principal, descriptor.id, "read");
    const stored: ScanResult = { ok: true, scanId, delivery: "stored", response: descriptor, numericCount: scanned.numericCount, provenance };
    if (Buffer.byteLength(serializeJson(stored)) > maxBytes) throw new ResponseBackendError("scan_envelope_too_large");
    return stored;
  }

  /** Inspect a link after owner/origin authorization, including payload integrity. */
  async inspect(principal: Principal, id: string): Promise<unknown> {
    const deadlineAt = Date.now() + this.limits.readJobMs;
    const owner = this.ownerKey(principal);
    if (!RESPONSE_ID.test(id)) throw new ResponseBackendError("response_not_found");
    const row = await this.operation({ operation: "row", id }, owner, deadlineAt) as Record<string, unknown> | null;
    if (!row || row.owner_key !== owner) throw new ResponseBackendError("response_not_found");
    const record = rowToRecord(row);
    if (!(await this.isAuthorized(record, principal, "describe", 0, deadlineAt))) throw new ResponseBackendError("response_not_found");
    let state: string = record.state;
    if (state === "committed" && Number(row.expires_at) <= this.now()) state = "expired";
    if (state === "committed") {
      const path = this.responsePath(owner, id);
      try {
        await assertRegularContained(path, this.responsesRoot);
        const verified = await this.jobs.submit({ kind: "response-read", ownerKey: owner, handler: "responses.verify", deadlineMs: this.remaining(deadlineAt), input: { path, sha256: record.descriptor.sha256 } });
        if (!verified.ok) throw new ResponseBackendError("response_integrity_unavailable");
        if (verified.value !== true) state = "corrupt";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") state = "unavailable";
        else throw error;
      }
    }
    if (!(await this.isAuthorized(record, principal, "describe", 0, deadlineAt))) throw new ResponseBackendError("response_not_found");
    return { ok: state === "committed", response: record.descriptor, operationId: record.operationId, executionId: record.executionId, state, ...(record.derived ? { provenance: record.derived } : {}) };
  }

  async describe(principal: Principal, id: string): Promise<ResponseRecord> {
    const row = await this.authorizedRow(principal, id, "describe");
    return row;
  }

  async shape(principal: Principal, input: { readonly id: string; readonly pointer?: string; readonly offset?: number; readonly limit?: number; readonly maxBytes?: number; readonly signal?: AbortSignal }): Promise<ResponseShape> {
    const deadlineAt = Date.now() + this.limits.readJobMs;
    input.signal?.throwIfAborted();
    const row = await this.authorizedRow(principal, input.id, "describe", 0, deadlineAt);
    const offset = input.offset ?? 0, limit = input.limit ?? 50, maxBytes = input.maxBytes ?? 12288;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 12288) throw new ResponseBackendError("response_invalid_page_request");
    const file = this.responsePath(row.ownerKey, input.id);
    await assertRegularContained(file, this.responsesRoot);
    const result = await this.jobs.submit({ kind: "response-read", ownerKey: row.ownerKey, handler: "responses.shape", ...(input.signal ? { signal: input.signal } : {}), deadlineMs: this.remaining(deadlineAt), input: { path: file, pointer: input.pointer ?? "", offset, limit, maxBytes, maxDepth: CONTRACT_LIMITS.maxJsonDepth, maxNodes: CONTRACT_LIMITS.maxNodes, expectedSha256: row.descriptor.sha256 } });
    if (!result.ok) throw new ResponseBackendError(result.code, result.message);
    const shape = responseShapeSchema.parse(result.value);
    await this.authorizedRow(principal, input.id, "describe", 0, deadlineAt);
    input.signal?.throwIfAborted();
    return shape;
  }

  async read(principal: Principal, input: { readonly id: string; readonly pointer?: string; readonly offset?: number; readonly limit?: number; readonly maxBytes?: number; readonly signal?: AbortSignal }): Promise<ReadPage> {
    const deadlineAt = Date.now() + this.limits.readJobMs;
    const row = await this.authorizedRow(principal, input.id, "read", 0, deadlineAt);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new ResponseBackendError("response_invalid_page_request");
    if (input.maxBytes !== undefined && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1)) throw new ResponseBackendError("response_invalid_page_request");
    const file = this.responsePath(row.ownerKey, input.id);
    await assertRegularContained(file, this.responsesRoot);
    const result = await this.jobs.submit({ kind: "response-read", ownerKey: row.ownerKey, handler: "responses.read", ...(input.signal ? { signal: input.signal } : {}), deadlineMs: this.remaining(deadlineAt), input: { path: file, pointer: input.pointer ?? "", offset, limit, maxBytes: Math.min(this.limits.maxReadBytes, input.maxBytes ?? this.limits.maxReadBytes), maxDepth: CONTRACT_LIMITS.maxJsonDepth, maxNodes: CONTRACT_LIMITS.maxNodes, expectedSha256: row.descriptor.sha256 } });
    if (!result.ok) throw new ResponseBackendError(result.code, result.message);
    const workerValue = result.value as Record<string, unknown>;
    if (workerValue.ok === false) throw new ResponseBackendError(typeof workerValue.code === "string" ? workerValue.code : "response_read_failed", typeof workerValue.message === "string" ? workerValue.message : "response read failed");
    const page = { ...workerValue, responseId: input.id, sha256: row.descriptor.sha256 };
    try { validateReadPage(page); } catch (error) { throw new ResponseBackendError("response_page_invalid", error instanceof Error ? error.message : "worker returned invalid page"); }
    await this.authorizedRow(principal, input.id, "read", 0, deadlineAt);
    input.signal?.throwIfAborted();
    return page;
  }

  async list(input: ListResponsesOptions): Promise<ListedResponses> {
    const ownerKey = this.ownerKey(input.principal);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new ResponseBackendError("response_invalid_list_limit");
    const cursor = input.cursor ? decodeCursor(input.cursor, ownerKey, input.executionId ?? null) : { highWater: this.now(), created: 0, id: "" };
    const visible: ResponseRecord[] = [];
    let scanCreated = cursor.created;
    let scanId = cursor.id;
    let exhausted = false;
    while (visible.length <= limit && !exhausted) {
      const rows = await this.operation({ operation: "list", ownerKey, now: this.now(), highWater: cursor.highWater, created: scanCreated, id: scanId, executionId: input.executionId ?? null, limit: limit + 1 }, ownerKey) as Array<Record<string, unknown>>;
      if (rows.length === 0) { exhausted = true; break; }
      for (const row of rows) {
        scanCreated = Number(row.created_at); scanId = String(row.id);
        const record = rowToRecord(row);
        if (await this.isAuthorized(record, input.principal, "list")) visible.push(record);
        if (visible.length > limit) break;
      }
      if (rows.length < limit + 1) exhausted = true;
    }
    const records = visible.slice(0, limit);
    const last = records.at(-1);
    return { records, nextCursor: visible.length > limit && last ? encodeCursor({ ownerKey, executionId: input.executionId ?? null, highWater: cursor.highWater, created: Date.parse(last.descriptor.createdAt), id: last.descriptor.id }) : null };
  }

  async delete(principal: Principal, id: string): Promise<void> {
    const row = await this.authorizedRow(principal, id, "delete");
    const path = this.responseDir(row.ownerKey, id);
    try { await assertDirectoryTree(path, this.responsesRoot); }
    catch (error) {
      // A prior unlink may have succeeded while charging failed. Reconcile the
      // durable deleted row without accepting a missing/unsafe path as valid.
      if (row.state === "deleted" && isMissingFsError(error)) { await this.operation({ operation: "charge-delete", id, ownerKey: row.ownerKey }, row.ownerKey); return; }
      throw error;
    }
    await this.operation({ operation: "mark-delete", id, ownerKey: row.ownerKey }, row.ownerKey);
    try {
      await removeContainedDirectory(path, this.responsesRoot, false);
    } catch (error) {
      if (isMissingFsError(error)) { await this.operation({ operation: "charge-delete", id, ownerKey: row.ownerKey }, row.ownerKey); return; }
      throw new ResponseBackendError("response_delete_pending", error instanceof Error ? error.message : "response files could not be deleted");
    }
    await this.operation({ operation: "charge-delete", id, ownerKey: row.ownerKey }, row.ownerKey);
  }

  async path(principal: Principal, id: string): Promise<string> {
    if (principal.kind !== "local") throw new ResponseBackendError("response_path_local_only");
    const row = await this.authorizedRow(principal, id, "path");
    const file = this.responsePath(row.ownerKey, id);
    await assertRegularContained(file, this.responsesRoot);
    return file;
  }

  async pruneExpired(): Promise<number> {
    const now = this.now();
    const rows = await this.operation({ operation: "prune-mark", now }, "response-maintenance") as Array<Record<string, unknown>>;
    let count = 0;
    for (const row of rows) {
      const id = String(row.id); const owner = String(row.owner_key);
      try { await removeContainedDirectory(this.responseDir(owner, id), this.responsesRoot, true); } catch { continue; }
      await this.operation({ operation: "prune-charge", id }, owner);
      count += 1;
    }
    return count;
  }

  async recoverExpired(): Promise<void> {
    const reservations = await this.operation({ operation: "expired-reservations", now: this.now() }, "response-maintenance") as Array<Record<string, unknown>>;
    for (const reservation of reservations) {
      const id = String(reservation.id); const owner = String(reservation.owner_key); const nonce = String(reservation.nonce);
      const final = this.finalPath(owner, id);
      const staging = join(this.stagingRoot, `${id}-${nonce}`);
      let candidate: "valid" | "future" | "invalid" | "unavailable" = "invalid";
      try {
        const claimed = await this.operation({ operation: "recovery-claim", id, nonce, now: this.now() }, "response-maintenance") as boolean;
        if (!claimed) continue;
        try { await assertDirectoryTree(final, this.responsesRoot); candidate = await validPublishedPair(final, nonce); } catch (error) { candidate = isTransientFsError(error) ? "unavailable" : "invalid"; }
        if (candidate === "unavailable") {
          await this.operation({ operation: "recovery-reset", id, nonce }, "response-maintenance").catch(() => undefined);
          continue;
        }
        if (candidate === "future") {
          await this.operation({ operation: "recovery-reset", id, nonce }, "response-maintenance");
          continue;
        }
        if (candidate === "valid") {
          const envelopeText = await readFile(join(final, "response.json"), "utf8");
          const metadataText = await readFile(join(final, "metadata.json"), "utf8");
          const metadata = JSON.parse(metadataText) as Record<string, unknown>;
          const envelope = JSON.parse(envelopeText) as NormalizedResponseEnvelope;
          const serialized = serializeNormalizedEnvelope(envelope, { maxBytes: this.limits.maxResponseBytes });
          const bytes = Buffer.byteLength(envelopeText, "utf8");
          const sha256 = createHash("sha256").update(envelopeText, "utf8").digest("hex");
          const descriptor = metadata.descriptor as ResponseDescriptor;
          validateResponseDescriptor(descriptor);
          if (metadata.id !== id || metadata.ownerKey !== owner || descriptor.id !== id || descriptor.bytes !== bytes || descriptor.sha256 !== sha256 || descriptor.createdAt !== new Date(Number(reservation.created_at)).toISOString() || descriptor.expiresAt !== new Date(Number(reservation.expires_at)).toISOString() || serialized.sha256 !== sha256 || bytes > Number(reservation.max_bytes)) throw new ResponseBackendError("response_corrupt");
          const provenance = metadata.provenance as Record<string, unknown> | undefined;
          await this.operation({ operation: "recovery-commit", id, owner, nonce, bytes, reservationMaxBytes: Number(reservation.max_bytes), charged: bytes + Buffer.byteLength(metadataText, "utf8"), maxBytesPerOwner: this.limits.maxBytesPerOwner, maxBytesPerRoot: this.limits.maxBytesPerRoot, sha256, created: Number(reservation.created_at), expires: Number(reservation.expires_at), descriptor, operationId: provenance?.operationId ?? null, callId: provenance?.callId ?? null, executionId: provenance?.executionId ?? null }, "response-maintenance");
        } else {
          await removeContainedDirectory(staging, this.stagingRoot, true).catch(() => undefined);
          await removeContainedDirectory(final, this.responsesRoot, true).catch(() => undefined);
          await this.operation({ operation: "recovery-fail", id, nonce }, "response-maintenance");
        }
      } catch {
        // A timeout or a lost recovery-commit reply must not destroy a valid
        // publication. Leave the recovering reservation for the next pass.
        if (candidate === "invalid") { try { await this.operation({ operation: "recovery-fail", id, nonce }, "response-maintenance"); } catch { /* another process owns recovery */ } }
      }
    }
  }

  private async authorizedRow(principal: Principal, id: string, action: "read" | "describe" | "delete" | "path" | "list", depth = 0, deadlineAt = Date.now() + this.limits.readJobMs): Promise<ResponseRecord> {
    if (depth > 8) throw new ResponseBackendError("response_lineage_limit");
    if (!RESPONSE_ID.test(id)) throw new ResponseBackendError("response_not_found");
    const row = await this.operation({ operation: "row", id }, this.ownerKey(principal), deadlineAt) as Record<string, unknown> | null;
    if (!row || row.owner_key !== this.ownerKey(principal)) throw new ResponseBackendError("response_not_found");
    const record = rowToRecord(row);
    const validState = action === "delete" ? (record.state === "committed" || record.state === "deleted") : record.state === "committed";
    if (record.ownerKey !== this.ownerKey(principal) || !validState || (record.state === "committed" && Number(row.expires_at) <= this.now()) || !(await this.isAuthorized(record, principal, action, depth, deadlineAt))) throw new ResponseBackendError("response_not_found");
    return record;
  }

  private async isAuthorized(record: ResponseRecord, principal: Principal, action: "read" | "describe" | "delete" | "path" | "list", depth = 0, deadlineAt = Date.now() + this.limits.readJobMs): Promise<boolean> {
    if (record.derived) {
      try {
        const parent = await this.authorizedRow(principal, record.derived.parentId, "read", depth + 1, deadlineAt);
        if (parent.descriptor.sha256 !== record.derived.parentSha256) return false;
        const path = this.responsePath(parent.ownerKey, parent.descriptor.id);
        await assertRegularContained(path, this.responsesRoot);
        const verified = await this.jobs.submit({ kind: "response-read", ownerKey: parent.ownerKey, handler: "responses.verify", deadlineMs: this.remaining(deadlineAt), input: { path, sha256: parent.descriptor.sha256 } });
        if (!verified.ok || verified.value !== true) return false;
      } catch (error) { if (error instanceof ResponseBackendError && error.code !== "response_not_found") throw error; return false; }
    }
    if (record.operationId === null) return (await this.options.policy?.authorizeOrigin?.(null, principal, action)) !== false;
    const policy = this.options.policy;
    if ((await policy?.isOriginDenied?.(record.operationId, principal)) === true) return false;
    const active = await policy?.isOriginActive?.(record.operationId);
    if (active === false) return (await policy?.allowRetainedOrigin?.(record.operationId, principal)) === true;
    return (await policy?.authorizeOrigin?.(record.operationId, principal, action)) !== false;
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private parseTime(value: string): number { const parsed = Date.parse(value); if (!Number.isFinite(parsed)) throw new ResponseBackendError("response_time_invalid"); return parsed; }
  private responseDir(owner: string, id: string): string { return this.finalPath(owner, id); }
  private responsePath(owner: string, id: string): string { return join(this.finalPath(owner, id), "response.json"); }
  private finalPath(owner: string, id: string): string { return join(this.responsesRoot, owner, id); }

  private async failReservation(reservation: ResponseReservation): Promise<void> {
    await this.operation({ operation: "fail-reservation", id: reservation.id, nonce: reservation.nonce }, reservation.ownerKey);
  }

  private remaining(deadlineAt: number): number { const remaining = Math.min(this.limits.readJobMs, deadlineAt - Date.now()); if (remaining <= 0) throw new ResponseBackendError("response_read_timeout"); return remaining; }

  private async operation(input: Record<string, unknown>, ownerKey: string, deadlineAt?: number): Promise<unknown> {
    const result: JobResult = await this.jobs.submit({ kind: "response-storage", ownerKey, handler: "responses.storage", deadlineMs: deadlineAt ? this.remaining(deadlineAt) : this.limits.readJobMs, input: { databasePath: join(this.tackRoot, "state.sqlite"), ...input } });
    if (!result.ok) throw new ResponseBackendError(result.code === "job_timeout" ? "response_storage_timeout" : result.code === "job_handler_error" && /^response_[a-z_]+(?::|$)/u.test(result.message) ? (result.message.split(":", 1)[0] ?? "response_persistence_failed") : "response_persistence_failed", result.message);
    return result.value;
  }
}

function normalizeLimits(input: ResponseStoreLimits | undefined): Required<ResponseStoreLimits> {
  const limits = { ...DEFAULTS, ...(input ?? {}) };
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new ResponseBackendError("response_limit_invalid", key);
  if (limits.previewMaxBytes > 2 * 1024 || limits.maxResponseBytes > CONTRACT_LIMITS.maxStoredResponseBytes || limits.maxReadBytes > CONTRACT_LIMITS.pageBytes || limits.maxBytesPerOwner > CONTRACT_LIMITS.maxPayloadBytesPerOwner || limits.maxBytesPerRoot > CONTRACT_LIMITS.maxPayloadBytesPerRoot || limits.maxResponsesPerOwner > CONTRACT_LIMITS.maxResponsesPerOwner || limits.maxResponsesPerRoot > CONTRACT_LIMITS.maxResponsesPerRoot || limits.readJobMs > 5_000 || limits.maxBytesPerOwner > limits.maxBytesPerRoot || limits.maxResponsesPerOwner > limits.maxResponsesPerRoot) throw new ResponseBackendError("response_limit_exceeds_cap");
  return limits;
}

function rowToRecord(row: Record<string, unknown>): ResponseRecord {
  let descriptor: ResponseDescriptor;
  try { descriptor = JSON.parse(String(row.descriptor_json)) as ResponseDescriptor; validateResponseDescriptor(descriptor); } catch { throw new ResponseBackendError("response_corrupt"); }
  let derived: DerivedProvenance | undefined;
  try { const provenance = row.provenance_json ? JSON.parse(String(row.provenance_json)) : {}; derived = provenance.derived; if (derived) { validateScanSpec(derived.spec); validateScanCoverage(derived.coverage); if (!RESPONSE_ID.test(derived.parentId) || !/^[a-f0-9]{64}$/.test(derived.parentSha256)) throw new Error("invalid parent"); } } catch { throw new ResponseBackendError("response_corrupt"); }
  return { ...(derived ? { derived } : {}), descriptor, ownerKey: String(row.owner_key), operationId: row.operation_id === null || row.operation_id === undefined ? null : String(row.operation_id), callId: row.call_id === null || row.call_id === undefined ? null : String(row.call_id), executionId: row.execution_id === null || row.execution_id === undefined ? null : String(row.execution_id), state: String(row.state) as ResponseRecord["state"] };
}

function descriptorFor(id: string, serialized: { bytes: number; sha256: string; rootShape: ResponseDescriptor["rootShape"] }, created: number, expires: number, provenance: ResponseProvenance, preview: unknown): ResponseDescriptor {
  const descriptor = { id, format: "tack-response-v1" as const, bytes: serialized.bytes, sha256: serialized.sha256, createdAt: new Date(created).toISOString(), expiresAt: new Date(expires).toISOString(), captureComplete: true as const, upstreamCompleteness: provenance.upstreamCompleteness ?? "unknown" as const, rootShape: serialized.rootShape, ...(preview === undefined ? {} : { shapePreview: preview }) };
  if (Buffer.byteLength(serializeJson(descriptor), "utf8") <= CONTRACT_LIMITS.descriptorBytes) return descriptor;
  const minimal = { ...descriptor, shapePreview: undefined };
  delete (minimal as { shapePreview?: unknown }).shapePreview;
  if (Buffer.byteLength(serializeJson(minimal), "utf8") > CONTRACT_LIMITS.descriptorBytes) throw new ResponseBackendError("response_descriptor_too_large");
  return minimal;
}

function metadataFor(reservation: ResponseReservation, descriptor: ResponseDescriptor, provenance: ResponseProvenance): Record<string, unknown> {
  return { formatVersion: 1, kind: "response-metadata", nonce: reservation.nonce, id: reservation.id, ownerKey: reservation.ownerKey, descriptor, provenance: JSON.parse(boundedProvenance(provenance)) };
}

function boundedProvenance(provenance: ResponseProvenance): string {
  const safe: Record<string, unknown> = { ...(provenance.upstreamOutcome ? { upstreamOutcome: provenance.upstreamOutcome } : {}), ...(provenance.derived ? { derived: provenance.derived } : {}) };
  for (const key of ["operationId", "callId", "executionId", "upstreamCompleteness"] as const) if (provenance[key] !== undefined) safe[key] = provenance[key];
  if (provenance.validation !== undefined) safe.validation = provenance.validation;
  const text = serializeJson(safe, { maxDepth: 8, maxNodes: 10_000 });
  if (Buffer.byteLength(text, "utf8") > 8 * 1024) throw new ResponseBackendError("response_metadata_too_large");
  return text;
}

async function ensureDirectory(path: string): Promise<void> {
  try { const info = await lstat(path); if (info.isSymbolicLink() || !info.isDirectory()) throw new ResponseBackendError("response_directory_unsafe"); }
  catch (error) { const code = error && typeof error === "object" && "code" in error ? error.code : undefined; if (code !== "ENOENT") throw error; await mkdir(path, { recursive: true, mode: 0o700 }); }
}

async function writeSynced(path: string, text: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await chmod(path, 0o600);
}

async function syncDirectory(path: string): Promise<void> { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }

function isMissingFsError(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"); }
function isTransientFsError(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && ["EACCES", "EPERM", "EBUSY", "EMFILE", "ENFILE"].includes(String(error.code))); }

async function removeContainedDirectory(path: string, root: string, force: boolean): Promise<void> {
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path);
  const rel = relative(canonicalRoot, canonicalPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.includes(`${sep}..${sep}`)) throw new ResponseBackendError("response_path_unsafe");
  await rm(canonicalPath, { recursive: true, force });
}

async function assertRegularContained(path: string, root: string): Promise<void> {
  await assertDirectoryTree(path, root);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new ResponseBackendError("response_file_unsafe");
}

async function assertDirectoryTree(path: string, root: string): Promise<void> {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.includes(`${sep}..${sep}`)) throw new ResponseBackendError("response_path_unsafe");
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new ResponseBackendError("response_path_unsafe");
  const segments = rel.split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new ResponseBackendError("response_path_unsafe");
  }
}

async function validPublishedPair(directory: string, nonce: string): Promise<"valid" | "future" | "invalid" | "unavailable"> {
  try {
    const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) return "invalid";
    const metadataPath = join(directory, "metadata.json"); const responsePath = join(directory, "response.json");
    const metaInfo = await lstat(metadataPath); const responseInfo = await lstat(responsePath);
    if (!metaInfo.isFile() || metaInfo.isSymbolicLink() || !responseInfo.isFile() || responseInfo.isSymbolicLink()) return "invalid";
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    if (typeof metadata.formatVersion === "number" && metadata.formatVersion > 1) return "future";
    return metadata.nonce === nonce && metadata.formatVersion === 1 && metadata.kind === "response-metadata" ? "valid" : "invalid";
  } catch (error) { return isTransientFsError(error) ? "unavailable" : "invalid"; }
}

function encodeCursor(input: { ownerKey: string; executionId: string | null; highWater: number; created: number; id: string }): string { return Buffer.from(serializeJson(input), "utf8").toString("base64url"); }
function decodeCursor(cursor: string, ownerKey: string, executionId: string | null): { highWater: number; created: number; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (value.ownerKey !== ownerKey || value.executionId !== executionId || !Number.isSafeInteger(value.highWater) || !Number.isSafeInteger(value.created) || typeof value.id !== "string") throw new Error();
    return { highWater: Number(value.highWater), created: Number(value.created), id: value.id };
  } catch { throw new ResponseBackendError("response_cursor_invalid"); }
}
