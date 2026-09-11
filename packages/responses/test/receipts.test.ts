import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createReceiptStore, deriveOwnerKey, type Principal } from "../dist/index.js";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const principal: Principal = { kind: "local", workspaceId };
async function root(): Promise<string> { const value = join(tmpdir(), `tack-receipts-${randomUUID()}`); await mkdir(join(value, ".tack"), { recursive: true }); return value; }

describe("bounded metadata receipts", () => {
  test("accounts actual metadata bytes and strips arbitrary event messages", async () => {
    const value = await root();
    const receipts = await createReceiptStore({ root: value, workspaceId });
    const execution = await receipts.start({ principal, deadlineMs: 1_000 });
    const event = await receipts.event(principal, { executionId: execution.executionId, kind: "upstream_error", message: "Bearer fixture-secret-from-upstream" });
    expect(event.message).toBeUndefined();
    await receipts.finish(principal, execution.executionId, "completed");
    const database = new DatabaseSync(join(value, ".tack", "state.sqlite"));
    const row = database.prepare("SELECT reserved_bytes FROM tack_executions WHERE execution_id = ?").get(execution.executionId) as { reserved_bytes: number };
    const stored = database.prepare("SELECT message FROM tack_receipt_events WHERE execution_id = ?").get(execution.executionId) as { message: string | null };
    expect(row.reserved_bytes).toBeGreaterThanOrEqual(4096);
    expect(stored.message).toBeNull();
    database.close(); await receipts.close(); await rm(value, { recursive: true, force: true });
  });

  test("enforces the D08 per-execution byte cap across call metadata", async () => {
    const value = await root();
    const receipts = await createReceiptStore({ root: value, workspaceId });
    const execution = await receipts.start({ principal, deadlineMs: 1_000 });
    await expect(receipts.recordCall(principal, { callId: "large-call", executionId: execution.executionId, schemaRevision: "x".repeat(2_100_000), inputValidation: "passed", outputValidation: "passed", upstreamOutcome: "succeeded", delivery: "inline", responseIds: [] })).rejects.toMatchObject({ code: "receipt_quota_exceeded" });
    await receipts.close(); await rm(value, { recursive: true, force: true });
  }, 15_000);

  test("preserves trusted call evidence after revocation while denying inspection", async () => {
    const value = await root();
    let allowed = true;
    const receipts = await createReceiptStore({ root: value, workspaceId, authorizeOperation: () => allowed });
    const execution = await receipts.start({ principal, deadlineMs: 1_000 });
    allowed = false;
    await expect(receipts.recordCall(principal, { callId: "denied-call", executionId: execution.executionId, operationId: "op-denied", inputValidation: "passed", outputValidation: "passed", upstreamOutcome: "succeeded", delivery: "inline", responseIds: [] })).resolves.toBeUndefined();
    await expect(receipts.inspect(principal, execution.executionId)).rejects.toMatchObject({ code: "receipt_not_found" });
    await receipts.close(); await rm(value, { recursive: true, force: true });
  });

  test("rejects new terminal mutations but preserves late call identity and authorization", async () => {
    const value = await root();
    let allowed = true;
    const receipts = await createReceiptStore({ root: value, workspaceId, authorizeOperation: () => allowed });
    const execution = await receipts.start({ principal, deadlineMs: 1_000 });
    const call = { callId: "late-call", executionId: execution.executionId, operationId: "op-original", schemaRevision: "schema-original", inputValidation: "passed" as const, outputValidation: "passed" as const, upstreamOutcome: "succeeded" as const, delivery: "inline" as const, responseIds: [] };
    await receipts.recordCall(principal, call);
    await receipts.finish(principal, execution.executionId, "completed");
    await expect(receipts.recordCall(principal, { callId: call.callId, executionId: call.executionId, inputValidation: call.inputValidation, outputValidation: call.outputValidation, upstreamOutcome: "failed", delivery: call.delivery, responseIds: [] })).rejects.toMatchObject({ code: "receipt_outcome_regression" });
    await expect(receipts.recordCall(principal, { ...call, operationId: "op-rewritten" })).rejects.toMatchObject({ code: "receipt_call_identity_mismatch" });
    const inspected = await receipts.inspect(principal, execution.executionId);
    expect(inspected.calls[0]).toMatchObject({ operation_id: "op-original", schema_revision: "schema-original", upstream_outcome: "succeeded" });
    allowed = false;
    await expect(receipts.inspect(principal, execution.executionId)).rejects.toMatchObject({ code: "receipt_not_found" });
    await expect(receipts.recordCall(principal, { ...call, upstreamOutcome: "succeeded" })).resolves.toBeUndefined();
    await expect(receipts.recordCall(principal, { ...call, callId: "new-call" })).rejects.toMatchObject({ code: "receipt_terminal_mutation" });
    await expect(receipts.event(principal, { executionId: execution.executionId, kind: "call", code: "stored" })).rejects.toMatchObject({ code: "receipt_terminal_mutation" });
    await expect(receipts.linkResponse(principal, execution.executionId, { responseId: "resp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", relation: "primary" })).rejects.toMatchObject({ code: "receipt_terminal_mutation" });
    await receipts.close(); await rm(value, { recursive: true, force: true });
  });

  test("rejects runtime nonterminal finish states", async () => {
    const value = await root();
    const receipts = await createReceiptStore({ root: value, workspaceId });
    const execution = await receipts.start({ principal, deadlineMs: 1_000 });
    await expect(receipts.finish(principal, execution.executionId, "running" as never)).rejects.toMatchObject({ code: "receipt_state_invalid" });
    await expect(receipts.finish(principal, execution.executionId, "completed")).resolves.toMatchObject({ state: "completed" });
    await receipts.close(); await rm(value, { recursive: true, force: true });
  });

  test("records a bounded capture gap at the D08 event limit", async () => {
    const value = await root();
    const receipts = await createReceiptStore({ root: value, workspaceId });
    const execution = await receipts.start({ principal, deadlineMs: 60_000 });
    for (let index = 0; index < 2_048; index += 1) await receipts.event(principal, { executionId: execution.executionId, kind: "event", code: "stored" });
    await expect(receipts.event(principal, { executionId: execution.executionId, kind: "event", code: "stored" })).resolves.toMatchObject({ kind: "capture_gap", code: "receipt_event_limit" });
    await expect(receipts.finish(principal, execution.executionId, "completed")).resolves.toMatchObject({ capture: "incomplete" });
    await receipts.close(); await rm(value, { recursive: true, force: true });
  }, 120_000); // Exercises 2048 durable sequential writes; not a throughput SLA.

  test("enforces the exact 10000 receipts-per-owner boundary", async () => {
    const value = await root();
    const first = await createReceiptStore({ root: value, workspaceId });
    const ownerKey = deriveOwnerKey(workspaceId, principal);
    await first.close();
    const database = new DatabaseSync(join(value, ".tack", "state.sqlite"));
    database.exec("BEGIN IMMEDIATE");
    const now = Date.now();
    for (let index = 0; index < 9_999; index += 1) database.prepare("INSERT INTO tack_executions (execution_id, owner_key, host_instance_id, state, capture, started_at, deadline_ms, expires_at, reserved_bytes) VALUES (?, ?, ?, 'completed', 'complete', ?, ?, ?, 4096)").run(`exec_seed_${index}`, ownerKey, "host-seed", now, now + 1_000, now + 86_400_000);
    database.exec("COMMIT"); database.close();
    const receipts = await createReceiptStore({ root: value, workspaceId });
    await expect(receipts.start({ principal, deadlineMs: 1_000 })).resolves.toBeDefined();
    await expect(receipts.start({ principal, deadlineMs: 1_000 })).rejects.toMatchObject({ code: "receipt_quota_exceeded" });
    await receipts.close(); await rm(value, { recursive: true, force: true });
  }, 30_000);

  test("recovers expired fences after cleanup grace and releases unused quota", async () => {
    const value = await root();
    let clock = 1_000;
    const receipts = await createReceiptStore({ root: value, workspaceId, now: () => clock });
    const expired = await receipts.start({ principal, deadlineMs: 1_000 });
    const live = await receipts.start({ principal, deadlineMs: 120_000 });
    clock = 31_999;
    expect(await receipts.recoverExpired()).toBe(0);
    clock = 32_000;
    expect(await receipts.recoverExpired()).toBe(1);
    expect((await receipts.getExecution(principal, expired.executionId)).state).toBe("interrupted");
    expect((await receipts.getExecution(principal, live.executionId)).state).toBe("running");
    const database = new DatabaseSync(join(value, ".tack", "state.sqlite"));
    expect(database.prepare("SELECT reserved_bytes FROM tack_executions WHERE execution_id = ?").get(expired.executionId)).toMatchObject({ reserved_bytes: 4096 });
    database.close();
    await receipts.close(); await rm(value, { recursive: true, force: true });
  });

  test("requires trusted termination evidence for positive host recovery", async () => {
    const value = await root();
    let clock = 1_000;
    const receipts = await createReceiptStore({ root: value, workspaceId, now: () => clock, verifyHostTermination: (assertion) => assertion.evidence === "host-terminated-v1" });
    const execution = await receipts.start({ principal, hostInstanceId: "host-a", deadlineMs: 1 });
    clock = 2_000;
    await expect(receipts.recoverExpired()).resolves.toBe(0);
    await expect(receipts.recoverExpired({ hostInstanceId: "host-a", terminatedAt: clock, evidence: "host-terminated-v1" })).resolves.toBe(1);
    await expect(receipts.getExecution(principal, execution.executionId)).resolves.toMatchObject({ state: "interrupted", capture: "incomplete" });
    await receipts.close(); await rm(value, { recursive: true, force: true });
  });

  test("reserves before effects, preserves call outcomes and links, and enforces current operation auth", async () => {
    const value = await root();
    let allowed = true;
    const receipts = await createReceiptStore({ root: value, workspaceId, authorizeOperation: () => allowed });
    const execution = await receipts.start({ principal, catalogRevision: "cat-1", deadlineMs: 1_000 });
    await receipts.recordCall(principal, { callId: "call-1", executionId: execution.executionId, operationId: "op-1", inputValidation: "passed", outputValidation: "unavailable", upstreamOutcome: "succeeded", delivery: "stored", responseIds: ["resp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] });
    await receipts.event(principal, { executionId: execution.executionId, kind: "call", code: "stored", message: "bounded" });
    await expect(receipts.inspect(principal, execution.executionId)).resolves.toMatchObject({ formatVersion: 1, calls: [{ format_version: 1, recorded_at: expect.any(Number) }], links: [{ format_version: 1, recorded_at: expect.any(Number) }], events: [{ format_version: 1, recorded_at: expect.any(Number) }] });
    const finished = await receipts.finish(principal, execution.executionId, "completed");
    expect(finished.state).toBe("completed");
    allowed = false;
    await expect(receipts.getExecution(principal, execution.executionId)).rejects.toMatchObject({ code: "receipt_not_found" });
    await receipts.close();
    await rm(value, { recursive: true, force: true });
  });
});

test("pages complete receipt collections within a byte cap and invalidates changed evidence", async () => {
  const value = await root();
  const receipts = await createReceiptStore({ root: value, workspaceId });
  try {
    const execution = await receipts.start({ principal, deadlineMs: 30000 });
    for (let i = 0; i < 15; i++) await receipts.event(principal, { executionId: execution.executionId, kind: "event" });
    const first = await receipts.inspect(principal, execution.executionId, 3, { maxBytes: 2048 });
    expect(first.nextOffset).toBe(3);
    await receipts.event(principal, { executionId: execution.executionId, kind: "event" });
    await expect(receipts.inspect(principal, execution.executionId, 3, { offset: 3, continuation: first.continuation })).rejects.toThrow("receipt_snapshot_changed");
    await receipts.finish(principal, execution.executionId, "completed");
    const sequences: unknown[] = [];
    let offset = 0, continuation: string | undefined;
    do {
      const page = await receipts.inspect(principal, execution.executionId, 3, { offset, continuation, maxBytes: 2048 });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(2048);
      sequences.push(...page.events.map((event) => event.sequence));
      continuation = page.continuation;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (offset < 100);
    expect(sequences).toEqual(Array.from({ length: 16 }, (_, i) => i));
  } finally { await receipts.close(); await rm(value, { recursive: true, force: true }); }
});

test("lists owner-scoped execution pages and omits revoked receipt summaries", async () => {
  const value = await root();
  let allowed = true;
  const receipts = await createReceiptStore({ root: value, workspaceId, authorizeOperation: () => allowed });
  try {
    const a = await receipts.start({ principal, deadlineMs: 30000 });
    await receipts.recordCall(principal, { callId: "listed", executionId: a.executionId, operationId: "listed-operation", inputValidation: "passed", outputValidation: "passed", upstreamOutcome: "succeeded", delivery: "inline", responseIds: [] });
    await receipts.finish(principal, a.executionId, "completed");
    const b = await receipts.start({ principal, deadlineMs: 30000 });
    await receipts.finish(principal, b.executionId, "completed");
    const forged = Buffer.from(JSON.stringify({ ownerKey: deriveOwnerKey(workspaceId, principal), highWater: Date.now(), beforeTime: Number.MAX_SAFE_INTEGER, beforeId: "~", operation: "prune", databasePath: "/must-not-open" })).toString("base64url");
    await expect(receipts.list(principal, { cursor: forged })).rejects.toMatchObject({ code: "receipt_cursor_invalid" });
    const first = await receipts.list(principal, { limit: 1 });
    const second = await receipts.list(principal, { limit: 1, cursor: first.nextCursor! });
    expect(new Set([...first.items, ...second.items].map((item) => item.executionId))).toEqual(new Set([a.executionId, b.executionId]));
    expect((await receipts.list({ kind: "user", workspaceId, userId: "other" })).items).toEqual([]);
    allowed = false;
    expect((await receipts.list(principal)).items.map((item) => item.executionId)).toEqual([b.executionId]);
  } finally { await receipts.close(); await rm(value, { recursive: true, force: true }); }
});
