import { randomUUID } from "node:crypto";
import { CONTRACT_LIMITS, validateReceiptResponseLink, validateScanCoverage, type ScanCoverage, type Principal, type ReceiptResponseLink, type UpstreamOutcome } from "@cbxss/tack-core";
import { createBoundedJobPool, type BoundedJobPool, type JobResult } from "@cbxss/tack-host-jobs";
import { deriveOwnerKey, type ScanResult } from "./store.js";
import { serializeJson } from "./serialization.js";

export type ExecutionState = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type ReceiptCapture = "complete" | "incomplete";
export interface HostTerminationAssertion { readonly hostInstanceId: string; readonly terminatedAt: number; readonly evidence: "host-terminated-v1"; }
export interface ReceiptStoreOptions { readonly root: string; readonly workspaceId: string; readonly now?: () => number; readonly hostInstanceId?: string; readonly authorizePrincipal?: (principal: Principal) => boolean | Promise<boolean>; readonly authorizeOperation?: (operationId: string, principal: Principal) => boolean | Promise<boolean>; readonly verifyHostTermination?: (assertion: HostTerminationAssertion) => boolean | Promise<boolean>; readonly jobs?: BoundedJobPool; }
export interface ReceiptStart { readonly principal: Principal; readonly catalogRevision?: string; readonly recipeId?: string; readonly recipeRevision?: string; readonly deadlineMs: number; readonly hostInstanceId?: string; }
export interface ExecutionReceipt { readonly executionId: string; readonly ownerKey: string; readonly state: ExecutionState; readonly capture: ReceiptCapture; readonly startedAt: string; readonly endedAt?: string; readonly catalogRevision?: string; readonly recipeId?: string; readonly recipeRevision?: string; }
export interface ReceiptCall { readonly recipeRunId?: string | undefined; readonly callId: string; readonly executionId: string; readonly operationId?: string; readonly schemaRevision?: string; readonly inputValidation: "passed" | "failed" | "partial" | "unavailable" | "skipped"; readonly outputValidation: "passed" | "failed" | "partial" | "unavailable" | "skipped"; readonly upstreamOutcome: UpstreamOutcome; readonly delivery: "inline" | "stored" | "failed"; readonly durationMs?: number; readonly responseIds: readonly string[]; }
export interface ReceiptEvent { readonly executionId: string; readonly sequence: number; readonly kind: string; readonly code?: string; readonly message?: string; }
export interface ReceiptScan { readonly recipeRunId?: string | undefined; readonly scanId: string; readonly parentId: string; readonly parentSha256: string; readonly operationId: string | null; readonly pointer: string; readonly specHash: string; readonly coverage: ScanCoverage; readonly responseId?: string | undefined; }
export interface ReceiptInspection { readonly offset: number; readonly continuation: string; readonly nextOffset: number | null; readonly totals: Readonly<Record<string, number>>; readonly recipes: readonly Record<string, unknown>[]; readonly scans: readonly Record<string, unknown>[]; readonly formatVersion: 1; readonly executionId: string; readonly calls: readonly Record<string, unknown>[]; readonly links: readonly Record<string, unknown>[]; readonly events: readonly Record<string, unknown>[]; }
export class ReceiptBackendError extends Error { constructor(readonly code: string, message = code) { super(message); this.name = "ReceiptBackendError"; } }

const SAFE_EVENT_KINDS = new Set(["call", "validation", "upstream", "delivery", "lifecycle", "event", "capture_gap"]);
const SAFE_EVENT_CODES = new Set(["stored", "failed", "cancelled", "timeout", "validation_failed", "upstream_failed", "delivery_failed", "receipt_event_limit"]);
export const RECEIPT_JOB_HANDLERS = {
  "receipts.storage": { module: new URL("./receipt-storage-worker.js", import.meta.url), exportName: "runReceiptOperation" }
} as const;

const RECEIPT_HANDLER = "receipts.storage";
const RECEIPT_JOB_MS = 5_000;

export async function createReceiptStore(options: ReceiptStoreOptions): Promise<ReceiptStore> { return ReceiptStore.open(options); }

export class ReceiptStore {
  private constructor(private readonly options: ReceiptStoreOptions, private readonly jobs: BoundedJobPool, private readonly databasePath: string, private readonly ownsJobs: boolean) {}

  static async open(options: ReceiptStoreOptions): Promise<ReceiptStore> {
    const databasePath = `${options.root}/.tack/state.sqlite`;
    const jobs = options.jobs ?? await createBoundedJobPool({ root: options.root, databasePath, limits: { maxJobMs: RECEIPT_JOB_MS, maxInputBytes: 32 * 1024 * 1024 }, handlers: RECEIPT_JOB_HANDLERS });
    const store = new ReceiptStore(options, jobs, databasePath, options.jobs === undefined);
    try { await store.operation({ operation: "init", now: store.now() }, "local"); }
    catch (error) { await store.close(); throw error; }
    return store;
  }

  close(): Promise<void> { return this.ownsJobs ? this.jobs.close() : Promise.resolve(); }

  async start(input: ReceiptStart): Promise<ExecutionReceipt> {
    if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= 0) throw new ReceiptBackendError("receipt_deadline_invalid");
    const ownerKey = deriveOwnerKey(this.options.workspaceId, input.principal);
    const executionId = `exec_${randomUUID()}`;
    const started = this.now();
    const value = await this.operation({ operation: "start", ownerKey, executionId, started, expires: started + CONTRACT_LIMITS.maxReceiptLifetimeDays * 24 * 60 * 60 * 1000, deadlineMs: input.deadlineMs, hostInstanceId: input.hostInstanceId ?? this.options.hostInstanceId ?? randomUUID(), catalogRevision: input.catalogRevision ?? null, recipeId: input.recipeId ?? null, recipeRevision: input.recipeRevision ?? null }, ownerKey);
    return toReceipt(value as Record<string, unknown>);
  }

  async recordCall(principal: Principal, call: ReceiptCall): Promise<void> {
    const ownerKey = deriveOwnerKey(this.options.workspaceId, principal);
    const responseIds = call.responseIds.filter((id) => /^resp_[0-9a-f-]{20,80}$/u.test(id)).slice(0, 32);
    const callBytes = Buffer.byteLength(serializeJson({ recipeRunId: call.recipeRunId ?? null, callId: call.callId, operationId: call.operationId ?? null, schemaRevision: call.schemaRevision ?? null, inputValidation: call.inputValidation, outputValidation: call.outputValidation, upstreamOutcome: call.upstreamOutcome, delivery: call.delivery, durationMs: call.durationMs ?? null, responseIds }), "utf8");
    if (callBytes > CONTRACT_LIMITS.maxReceiptBytesPerExecution) throw new ReceiptBackendError("receipt_quota_exceeded");
    await this.operation({ operation: "call", ownerKey, executionId: call.executionId, recipeRunId: call.recipeRunId ?? null, callId: call.callId, operationId: call.operationId ?? null, schemaRevision: call.schemaRevision ?? null, inputValidation: call.inputValidation, outputValidation: call.outputValidation, upstreamOutcome: call.upstreamOutcome, delivery: call.delivery, durationMs: call.durationMs ?? null, responseIds, callBytes, now: this.now() }, ownerKey);
  }

  async recordRecipe(principal: Principal, executionId: string, input: { runId: string; recipeId: string; programSha256: string; manifestSha256: string; lockSha256: string; state: "running" | "completed" | "partial" | "failed" }): Promise<void> {
    const encoded = serializeJson(input, { maxBytes: 2048 });
    const ownerKey = deriveOwnerKey(this.options.workspaceId, principal);
    await this.operation({ operation: "recipe", ownerKey, executionId, ...input, bytes: Buffer.byteLength(encoded), now: this.now() }, ownerKey);
  }

  async captureScan(principal: Principal, executionId: string, result: ScanResult, operationId: string | null, recipeRunId?: string): Promise<void> {
    await this.recordScan(principal, executionId, { ...(recipeRunId ? { recipeRunId } : {}), scanId: result.scanId, parentId: result.provenance.parentId, parentSha256: result.provenance.parentSha256, operationId, pointer: result.provenance.pointer, specHash: result.provenance.specHash, coverage: result.provenance.coverage, ...(result.response ? { responseId: result.response.id } : {}) });
    if (result.response) await this.linkResponse(principal, executionId, { responseId: result.response.id, relation: "derived" });
  }

  async recordScan(principal: Principal, executionId: string, scan: ReceiptScan): Promise<void> {
    validateScanCoverage(scan.coverage);
    const encoded = serializeJson(scan, { maxBytes: 8192 });
    const ownerKey = deriveOwnerKey(this.options.workspaceId, principal);
    await this.operation({ operation: "scan", ownerKey, executionId, scanId: scan.scanId, operationId: scan.operationId, encoded, bytes: Buffer.byteLength(encoded), now: this.now() }, ownerKey);
  }

  async linkResponse(principal: Principal, executionId: string, link: ReceiptResponseLink): Promise<void> {
    try { validateReceiptResponseLink(link); } catch (error) { throw new ReceiptBackendError("receipt_link_invalid", error instanceof Error ? error.message : "response link is invalid"); }
    const ownerKey = deriveOwnerKey(this.options.workspaceId, principal);
    await this.operation({ operation: "link", ownerKey, executionId, responseId: link.responseId, relation: link.relation, bytes: Buffer.byteLength(serializeJson({ executionId, responseId: link.responseId, relation: link.relation }), "utf8"), now: this.now() }, ownerKey);
  }

  async event(principal: Principal, input: { executionId: string; kind: string; code?: string; message?: string }): Promise<ReceiptEvent> {
    const ownerKey = deriveOwnerKey(this.options.workspaceId, principal);
    const kind = SAFE_EVENT_KINDS.has(input.kind) ? input.kind : "event";
    const code = input.code && SAFE_EVENT_CODES.has(input.code) ? input.code : undefined;
    const bytes = Buffer.byteLength(serializeJson({ kind, ...(code ? { code } : {}) }), "utf8");
    return await this.operation({ operation: "event", ownerKey, executionId: input.executionId, kind, code: code ?? null, bytes, now: this.now() }, ownerKey) as ReceiptEvent;
  }

  async finish(principal: Principal, executionId: string, state: Exclude<ExecutionState, "running" | "interrupted">): Promise<ExecutionReceipt> {
    if (!["completed", "failed", "cancelled"].includes(state)) throw new ReceiptBackendError("receipt_state_invalid");
    const ownerKey = deriveOwnerKey(this.options.workspaceId, principal);
    const value = await this.operation({ operation: "finish", ownerKey, executionId, state, ended: this.now(), now: this.now() }, ownerKey);
    return toReceipt(value as Record<string, unknown>);
  }

  async list(principal: Principal, options: { limit?: number | undefined; cursor?: string | undefined } = {}) {
    if (await this.options.authorizePrincipal?.(principal) === false) throw new ReceiptBackendError("receipt_not_found");
    const ownerKey = deriveOwnerKey(this.options.workspaceId, principal);
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ReceiptBackendError("receipt_inspection_limit_invalid");
    let cursor = { ownerKey, highWater: this.now(), beforeTime: Number.MAX_SAFE_INTEGER, beforeId: "~" };
    if (options.cursor) {
      if (options.cursor.length > 1024) throw new ReceiptBackendError("receipt_cursor_invalid");
      try { cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")); } catch { throw new ReceiptBackendError("receipt_cursor_invalid"); }
      if (!cursor || Object.keys(cursor).sort().join(",") !== "beforeId,beforeTime,highWater,ownerKey" || cursor.ownerKey !== ownerKey || !Number.isSafeInteger(cursor.highWater) || !Number.isSafeInteger(cursor.beforeTime) || typeof cursor.beforeId !== "string" || cursor.beforeId.length > 128) throw new ReceiptBackendError("receipt_cursor_invalid");
    }
    const rows = await this.operation({ operation: "list", ...cursor, limit, now: this.now() }, ownerKey) as Record<string, unknown>[];
    const items: ExecutionReceipt[] = [];
    for (const row of rows) {
      try { items.push(await this.getExecution(principal, String(row.execution_id))); }
      catch (error) { if (!(error instanceof ReceiptBackendError) || error.code !== "receipt_not_found") throw error; }
    }
    const last = rows.at(-1);
    const result = { formatVersion: 1, items, nextCursor: rows.length === limit && last ? Buffer.from(JSON.stringify({ ...cursor, beforeTime: Number(last.started_at), beforeId: String(last.execution_id) })).toString("base64url") : null };
    serializeJson(result, { maxBytes: 65536 });
    return result;
  }

  async inspect(principal: Principal, executionId: string, limit = 100, page: { readonly offset?: number | undefined; readonly continuation?: string | undefined; readonly maxBytes?: number } = {}): Promise<ReceiptInspection> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new ReceiptBackendError("receipt_inspection_limit_invalid");
    const offset = page.offset ?? 0, maxBytes = page.maxBytes ?? 65536;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 65536) throw new ReceiptBackendError("receipt_inspection_limit_invalid");
    const execution = await this.authorizedExecution(principal, executionId);
    const result = await this.operation({ operation: "inspect", ownerKey: execution.ownerKey, executionId, limit, offset, continuation: page.continuation ?? null, maxBytes, now: this.now() }, execution.ownerKey) as ReceiptInspection;
    await this.authorizedExecution(principal, executionId);
    return result;
  }

  async getExecution(principal: Principal, executionId: string): Promise<ExecutionReceipt> {
    if (await this.options.authorizePrincipal?.(principal) === false) throw new ReceiptBackendError("receipt_not_found");
    const ownerKey = deriveOwnerKey(this.options.workspaceId, principal);
    const value = await this.operation({ operation: "get", ownerKey, executionId, now: this.now() }, ownerKey) as { row?: Record<string, unknown>; operationIds: readonly string[] };
    if (!value.row) throw new ReceiptBackendError("receipt_not_found");
    for (const operation of value.operationIds) if ((await this.options.authorizeOperation?.(operation, principal)) === false) throw new ReceiptBackendError("receipt_not_found");
    return toReceipt(value.row);
  }

  async pruneExpired(): Promise<number> { return Number(await this.operation({ operation: "prune", now: this.now() }, "receipt-maintenance")); }
  async recoverExpired(assertion?: HostTerminationAssertion): Promise<number> {
    // Expiration includes a cleanup grace period; positive termination is a separate trusted path.
    if (!assertion) return Number(await this.operation({ operation: "recover", now: this.now(), expiredBefore: this.now() - 30_000, hostInstanceId: null }, "receipt-maintenance"));
    if (!this.options.verifyHostTermination || !(await this.options.verifyHostTermination(assertion))) throw new ReceiptBackendError("receipt_recovery_not_authorized");
    if (!assertion.hostInstanceId || !Number.isSafeInteger(assertion.terminatedAt) || assertion.terminatedAt > this.now()) throw new ReceiptBackendError("receipt_recovery_assertion_invalid");
    return Number(await this.operation({ operation: "recover", now: this.now(), hostInstanceId: assertion.hostInstanceId }, "receipt-maintenance"));
  }
  private async authorizedExecution(principal: Principal, id: string): Promise<ExecutionReceipt> { return this.getExecution(principal, id); }
  private now(): number { return this.options.now?.() ?? Date.now(); }

  private async operation(input: Record<string, unknown>, ownerKey: string): Promise<unknown> {
    const result: JobResult = await this.jobs.submit({ kind: "receipt-storage", ownerKey, handler: RECEIPT_HANDLER, deadlineMs: RECEIPT_JOB_MS, input: { databasePath: this.databasePath, ...input } });
    if (!result.ok) throw new ReceiptBackendError(result.code === "job_timeout" ? "receipt_storage_timeout" : result.code === "job_handler_error" && /^receipt_[a-z_]+(?::|$)/u.test(result.message) ? (result.message.split(":", 1)[0] ?? "receipt_storage_failed") : "receipt_storage_failed", result.message);
    return result.value;
  }
}

function toReceipt(row: Record<string, unknown>): ExecutionReceipt { return { executionId: String(row.execution_id), ownerKey: String(row.owner_key), state: String(row.state) as ExecutionState, capture: String(row.capture) as ReceiptCapture, startedAt: new Date(Number(row.started_at)).toISOString(), ...(row.ended_at === null || row.ended_at === undefined ? {} : { endedAt: new Date(Number(row.ended_at)).toISOString() }), ...(row.catalog_revision ? { catalogRevision: String(row.catalog_revision) } : {}), ...(row.recipe_id ? { recipeId: String(row.recipe_id) } : {}), ...(row.recipe_revision ? { recipeRevision: String(row.recipe_revision) } : {}) }; }
