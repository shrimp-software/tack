import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { createResponseStore, ResponseBackendError, serializeJson, serializeNormalizedEnvelope, type ResponseProvenance } from "../dist/index.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const local = { kind: "local" as const, workspaceId };
const other = { kind: "user" as const, workspaceId, userId: "other" };
const provenance: ResponseProvenance = { upstreamOutcome: "succeeded", operationId: "op_123" };
async function root(): Promise<string> { const value = join(tmpdir(), `tack-responses-${randomUUID()}`); await mkdir(value, { recursive: true }); return value; }

describe("response serializer", () => {
  test("charges exact UTF-8, escaped strings, keys and punctuation before exceeding the cap", () => {
    for (const value of [null, "é\\n😀", [true, 3, "x"], { "α": "\\\"", nested: [null] }]) {
      const encoded = serializeJson(value);
      const bytes = Buffer.byteLength(encoded);
      expect(serializeJson(value, { maxBytes: bytes })).toBe(encoded);
      expect(() => serializeJson(value, { maxBytes: bytes - 1 })).toThrow(expect.objectContaining({ code: "response_too_large" }));
    }
    let touched = false;
    expect(() => serializeJson({ a: "x".repeat(1_000_000), get z() { touched = true; return 1; } }, { maxBytes: 100 })).toThrow(expect.objectContaining({ code: "response_too_large" }));
    expect(touched).toBe(false);
  });
  test("does not invoke toJSON/getters and rejects lossy values", () => {
    let called = false;
    const value = { safe: 1, get secret() { called = true; return 2; } };
    expect(() => serializeJson(value)).toThrow();
    expect(called).toBe(false);
    expect(() => serializeJson({ toJSON: () => 1 })).toThrow();
    expect(() => serializeJson([, 1])).toThrow();
    expect(() => serializeJson({ value: undefined })).toThrow();
    expect(() => serializeJson(new Date())).toThrow();
    expect(() => serializeNormalizedEnvelope({ get formatVersion() { called = true; return 1; }, kind: "tool-response", upstreamOutcome: "succeeded", data: 1, text: "" } as any)).toThrow();
    expect(called).toBe(false);
  });
});

describe("durable responses", () => {
  test("retains, reads through a worker, and survives store restart", async () => {
    const value = await root();
    const first = await createResponseStore({ root: value, workspaceId });
    const descriptor = await first.retain(local, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: { results: ["α", null, { ok: true }], "__proto__": "data" }, text: "ok" }, provenance);
    expect(descriptor.bytes).toBeGreaterThan(0);
    const page = await first.read(local, { id: descriptor.id, pointer: "/data/results", offset: 0, limit: 2 });
    expect(page.value).toEqual(["α", null]);
    expect(page.hasMore).toBe(true);
    await first.close();
    const second = await createResponseStore({ root: value, workspaceId });
    await expect(second.read(local, { id: descriptor.id, pointer: "/data/results", offset: 2, limit: 10 })).resolves.toMatchObject({ value: [{ ok: true }], hasMore: false });
    await expect(second.describe(other, descriptor.id)).rejects.toMatchObject({ code: "response_not_found" });
    await second.close();
    await rm(value, { recursive: true, force: true });
  }, 15_000);

  test("publishes within quota, scans past denied rows, and hides expired rows", async () => {
    const value = await root();
    let clock = 1_000_000;
    const store = await createResponseStore({ root: value, workspaceId, now: () => clock, limits: { maxBytesPerOwner: 25_000, maxBytesPerRoot: 25_000, retentionMs: 1_000 }, policy: { authorizeOrigin: (operationId) => operationId === "op_allowed" } });
    await expect(store.retain(local, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: "x".repeat(15_000), text: "" }, { upstreamOutcome: "succeeded", operationId: "op_quota" })).resolves.toBeDefined();
    const denied = await store.retain(local, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: 1, text: "" }, { upstreamOutcome: "succeeded", operationId: "op_denied" });
    const allowed = await store.retain(local, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: 2, text: "" }, { upstreamOutcome: "succeeded", operationId: "op_allowed" });
    expect(denied.id).not.toBe(allowed.id);
    await expect(store.list({ principal: local, limit: 1 })).resolves.toMatchObject({ records: [{ operationId: "op_allowed" }], nextCursor: null });
    clock += 2_000;
    await expect(store.list({ principal: local, limit: 10 })).resolves.toMatchObject({ records: [] });
    await store.close(); await rm(value, { recursive: true, force: true });
  }, 15_000);

  test("serializes concurrent publication through bounded storage workers", async () => {
    const value = await root();
    const store = await createResponseStore({ root: value, workspaceId });
    const results = await Promise.allSettled([store.retain(local, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: 1, text: "" }, provenance), store.retain(local, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: 2, text: "" }, provenance)]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    await store.close(); await rm(value, { recursive: true, force: true });
  }, 15_000);

  test("requires an exact archive grant for retired origins and never overrides deny", async () => {
    const value = await root();
    let grant = false;
    let denied = false;
    const store = await createResponseStore({ root: value, workspaceId, policy: { isOriginActive: () => false, allowRetainedOrigin: () => grant, isOriginDenied: () => denied, authorizeOrigin: () => false } });
    const descriptor = await store.retain(local, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: [1], text: "" }, provenance);
    await expect(store.describe(local, descriptor.id)).rejects.toMatchObject({ code: "response_not_found" });
    grant = true;
    await expect(store.describe(local, descriptor.id)).resolves.toBeDefined();
    denied = true;
    await expect(store.describe(local, descriptor.id)).rejects.toMatchObject({ code: "response_not_found" });
    await store.close(); await rm(value, { recursive: true, force: true });
  });

  test("distinguishes absent pointer from present null and rejects path escapes", async () => {
    const value = await root();
    const store = await createResponseStore({ root: value, workspaceId });
    const descriptor = await store.retain(local, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: { nil: null }, text: "" }, provenance);
    await expect(store.read(local, { id: descriptor.id, pointer: "/missing" })).rejects.toMatchObject({ code: "response_pointer_invalid" });
    await expect(store.read(local, { id: descriptor.id, pointer: "/data/nil" })).resolves.toMatchObject({ kind: "scalar", value: null, total: 1 });
    await expect(store.path(other, descriptor.id)).rejects.toMatchObject({ code: "response_path_local_only" });
    await store.close();
    await rm(value, { recursive: true, force: true });
  }, 15_000);

  test("rejects an over-cap normalized envelope before publication", async () => {
    const value = await root();
    const store = await createResponseStore({ root: value, workspaceId, limits: { maxResponseBytes: 128 } });
    await expect(store.retain(local, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: { large: "x".repeat(500) }, text: "" }, provenance)).rejects.toMatchObject({ code: "response_too_large" });
    await store.close(); await rm(value, { recursive: true, force: true });
  });

  test("releases owner entry quota after successful delete", async () => {
    const value = await root();
    const store = await createResponseStore({ root: value, workspaceId, limits: { maxResponsesPerOwner: 1 } });
    const first = await store.retain(local, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: 1, text: "" }, provenance);
    await store.delete(local, first.id);
    const database = new DatabaseSync(join(value, ".tack", "state.sqlite"));
    const row = database.prepare("SELECT state, charged_bytes FROM tack_responses WHERE id = ?").get(first.id) as { state: string; charged_bytes: number };
    database.close();
    expect(row).toMatchObject({ state: "deleted", charged_bytes: 0 });
    await expect(store.retain(local, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: 2, text: "" }, provenance)).resolves.toBeDefined();
    await store.close(); await rm(value, { recursive: true, force: true });
  });

  test("keeps a valid publication retryable when recovery inspection gets EACCES", async () => {
    const value = await root();
    let clock = Date.now();
    const store = await createResponseStore({ root: value, workspaceId, now: () => clock });
    const reservation = await store.reserve(local, 4_096, provenance);
    const descriptor = await store.publish(local, reservation, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: { valid: true }, text: "" }, provenance);
    const directory = join(value, ".tack", "responses", reservation.ownerKey, reservation.id);
    const metadata = join(directory, "metadata.json");
    const payload = join(directory, "response.json");
    const database = new DatabaseSync(join(value, ".tack", "state.sqlite"));
    database.exec("BEGIN IMMEDIATE"); database.prepare("DELETE FROM tack_responses WHERE id = ?").run(descriptor.id); database.prepare("UPDATE tack_response_reservations SET state = 'publishing' WHERE id = ?").run(reservation.id); database.exec("COMMIT");
    database.close();
    clock = Date.parse(reservation.fenceExpiresAt) + 1;
    await chmod(metadata, 0);
    try {
      let code: string | undefined;
      try { await readFile(metadata); } catch (error) { code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined; }
      expect(code).toBe("EACCES");
      await store.recoverExpired();
    } finally { await chmod(metadata, 0o600); }
    expect(await readFile(payload, "utf8")).toContain("valid");
    const after = new DatabaseSync(join(value, ".tack", "state.sqlite"));
    const state = after.prepare("SELECT state FROM tack_response_reservations WHERE id = ?").get(reservation.id) as { state: string };
    after.close(); expect(state.state).toBe("reserved");
    await store.close(); await rm(value, { recursive: true, force: true });
  }, 15_000);

  test("binds publication timestamps to the durable reservation", async () => {
    const value = await root();
    const store = await createResponseStore({ root: value, workspaceId });
    const reservation = await store.reserve(local, 4_096, provenance);
    const forged = { ...reservation, expiresAt: new Date(Date.parse(reservation.createdAt) + 31 * 24 * 60 * 60 * 1000).toISOString() };
    await expect(store.publish(local, forged, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: 1, text: "" }, provenance)).rejects.toMatchObject({ code: "response_reservation_fenced" });
    await expect(store.publish(local, reservation, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: 1, text: "" }, provenance)).resolves.toMatchObject({ expiresAt: reservation.expiresAt });
    await store.close(); await rm(value, { recursive: true, force: true });
  });

  test("charges reservations against owner quota before publication", async () => {
    const value = await root();
    const store = await createResponseStore({ root: value, workspaceId, limits: { maxBytesPerOwner: 10, maxBytesPerRoot: 20 } });
    await store.reserve(local, 8, provenance);
    await expect(store.reserve(local, 8, provenance)).rejects.toMatchObject({ code: "response_quota_exceeded" });
    await store.close(); await rm(value, { recursive: true, force: true });
  });

  test("recovers expired incomplete reservations without retaining quota", async () => {
    const value = await root();
    let clock = 1_000_000;
    const store = await createResponseStore({ root: value, workspaceId, now: () => clock, limits: { maxBytesPerOwner: 10, maxBytesPerRoot: 20 } });
    const reservation = await store.reserve(local, 8, provenance);
    await mkdir(join(value, ".tack", "staging", `${reservation.id}-${reservation.nonce}`), { recursive: true });
    await store.close();
    clock += 31_000;
    const reopened = await createResponseStore({ root: value, workspaceId, now: () => clock, limits: { maxBytesPerOwner: 10, maxBytesPerRoot: 20 } });
    await expect(reopened.reserve(local, 8, provenance)).resolves.toBeDefined();
    await reopened.close(); await rm(value, { recursive: true, force: true });
  });

  test("rejects a symlinked response ancestor during publication", async () => {
    const value = await root();
    const store = await createResponseStore({ root: value, workspaceId });
    const reservation = await store.reserve(local, 128, provenance);
    const ownerPath = join(value, ".tack", "responses", reservation.ownerKey);
    const outside = join(value, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, ownerPath);
    await expect(store.publish(local, reservation, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: 1, text: "" }, provenance)).rejects.toMatchObject({ code: "response_directory_unsafe" });
    await store.close(); await rm(value, { recursive: true, force: true });
  });

  test("prune refuses an escaped response directory", async () => {
    const value = await root();
    let clock = 1_000_000;
    const store = await createResponseStore({ root: value, workspaceId, now: () => clock, limits: { retentionMs: 1_000 } });
    const descriptor = await store.retain(local, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: 1, text: "" }, provenance);
    const ownerPath = join(value, ".tack", "responses", store.ownerKey(local));
    const outside = join(value, "outside");
    const outsideTarget = join(outside, descriptor.id);
    await mkdir(outsideTarget, { recursive: true }); await writeFile(join(outsideTarget, "marker"), "outside", "utf8");
    await rm(ownerPath, { recursive: true }); await symlink(outside, ownerPath);
    clock += 2_000;
    await expect(store.pruneExpired()).resolves.toBe(0);
    await expect(readFile(join(outsideTarget, "marker"), "utf8")).resolves.toBe("outside");
    const database = new DatabaseSync(join(value, ".tack", "state.sqlite"));
    const row = database.prepare("SELECT state, charged_bytes FROM tack_responses WHERE id = ?").get(descriptor.id) as { state: string; charged_bytes: number };
    database.close(); expect(row).toMatchObject({ state: "expired" }); expect(row.charged_bytes).toBeGreaterThan(0);
    await store.close(); await rm(value, { recursive: true, force: true });
  });

  test("retains a renamed pair when publication commit reports an error", async () => {
    const value = await root();
    const store = await createResponseStore({ root: value, workspaceId });
    const reservation = await store.reserve(local, 4_096, provenance);
    const database = new DatabaseSync(join(value, ".tack", "state.sqlite"));
    database.exec("CREATE TRIGGER injected_publication_failure BEFORE INSERT ON tack_responses BEGIN SELECT RAISE(ABORT, 'injected_commit_failure'); END;"); database.close();
    await expect(store.publish(local, reservation, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: { durable: true }, text: "" }, provenance)).rejects.toMatchObject({ code: "response_persistence_failed" });
    const directory = join(value, ".tack", "responses", reservation.ownerKey, reservation.id);
    await expect(readFile(join(directory, "response.json"), "utf8")).resolves.toContain("durable");
    const after = new DatabaseSync(join(value, ".tack", "state.sqlite"));
    const row = after.prepare("SELECT state FROM tack_response_reservations WHERE id = ?").get(reservation.id) as { state: string };
    after.close(); expect(row.state).toBe("publishing");
    await store.close(); await rm(value, { recursive: true, force: true });
  });

  test("fences a stale writer after the trusted clock crosses its publication deadline", async () => {
    const value = await root();
    let clock = 1_000_000;
    const store = await createResponseStore({ root: value, workspaceId, now: () => clock });
    const reservation = await store.reserve(local, 128, provenance);
    clock += 31_000;
    await expect(store.publish(local, reservation, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: 1, text: "" }, provenance)).rejects.toMatchObject({ code: "response_reservation_fenced" });
    await store.close(); await rm(value, { recursive: true, force: true });
  });

  test("validates persisted descriptors on ordinary metadata access", async () => {
    const value = await root();
    const store = await createResponseStore({ root: value, workspaceId });
    const descriptor = await store.retain(local, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: [1], text: "" }, provenance);
    const database = new DatabaseSync(join(value, ".tack", "state.sqlite"));
    database.prepare("UPDATE tack_responses SET descriptor_json = ? WHERE id = ?").run(JSON.stringify({ id: descriptor.id }), descriptor.id);
    database.close();
    await expect(store.describe(local, descriptor.id)).rejects.toMatchObject({ code: "response_corrupt" });
    await store.close(); await rm(value, { recursive: true, force: true });
  });

  test("rejects a payload whose bytes no longer match the committed digest", async () => {
    const value = await root();
    const store = await createResponseStore({ root: value, workspaceId });
    const descriptor = await store.retain(local, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: [1], text: "" }, provenance);
    const file = await store.path(local, descriptor.id);
    await writeFile(file, "{}", "utf8");
    await expect(store.read(local, { id: descriptor.id })).rejects.toMatchObject({ code: "response_corrupt" });
    await store.close(); await rm(value, { recursive: true, force: true });
  });

  test("does not delete a future-format abandoned publication", async () => {
    const value = await root();
    let clock = 1_000_000;
    const store = await createResponseStore({ root: value, workspaceId, now: () => clock });
    const reservation = await store.reserve(local, 8, provenance);
    const directory = join(value, ".tack", "responses", reservation.ownerKey, reservation.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "response.json"), "{}", "utf8");
    await writeFile(join(directory, "metadata.json"), JSON.stringify({ formatVersion: 99, kind: "future-response", nonce: reservation.nonce }), "utf8");
    await store.close();
    clock += 31_000;
    const reopened = await createResponseStore({ root: value, workspaceId, now: () => clock });
    await expect(import("node:fs/promises").then(({ stat }) => stat(join(directory, "metadata.json")))).resolves.toBeDefined();
    await reopened.close(); await rm(value, { recursive: true, force: true });
  });

  test("never follows a response symlink", async () => {
    const value = await root();
    const store = await createResponseStore({ root: value, workspaceId });
    const descriptor = await store.retain(local, { formatVersion: 1, kind: "tool-response", upstreamOutcome: "succeeded", data: [1], text: "" }, provenance);
    await store.close();
    const outside = join(value, "outside"); await writeFile(outside, "{}");
    const responseDir = join(value, ".tack", "responses", store.ownerKey(local), descriptor.id);
    await rm(join(responseDir, "response.json")); await symlink(outside, join(responseDir, "response.json"));
    const reopened = await createResponseStore({ root: value, workspaceId });
    await expect(reopened.read(local, { id: descriptor.id })).rejects.toMatchObject({ code: "response_path_unsafe" });
    await reopened.close(); await rm(value, { recursive: true, force: true });
  }, 15_000);
});
