import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { beginImmediate, configureStateDatabase, createBoundedJobPool, openStateDatabase } from "../dist/index.js";

const handler = new URL("./job-handler.mjs", import.meta.url);
const cacheHandler = new URL("./cache-handler.mjs", import.meta.url);
async function root(): Promise<string> { const value = join(tmpdir(), `tack-jobs-${randomUUID()}`); await mkdir(value, { recursive: true }); return value; }

describe("bounded host jobs", () => {
  test("enforces the low-level SQLite busy-timeout hard cap", async () => {
    const value = await root();
    const database = await openStateDatabase(join(value, ".tack", "state.sqlite"));
    expect(() => configureStateDatabase(database, 5_001)).toThrow("busy_timeout_exceeds_hard_cap");
    configureStateDatabase(database, 5_000);
    database.close(); await rm(value, { recursive: true, force: true });
  });

  test("does not report coordinator readiness before locked initialization completes", async () => {
    const value = await root(); await mkdir(join(value, ".tack"), { recursive: true });
    const database = new DatabaseSync(join(value, ".tack", "state.sqlite")); database.exec("BEGIN IMMEDIATE");
    let released = false; const unlock = setTimeout(() => { database.exec("COMMIT"); database.close(); released = true; }, 200);
    let ready = false;
    try {
      const creating = createBoundedJobPool({ root: value, handlers: { echo: { module: handler, exportName: "run" } } }).then((pool) => { ready = true; return pool; });
      await new Promise((resolve) => setTimeout(resolve, 75)); expect(ready).toBe(false);
      const pool = await creating; await expect(pool.submit({ kind: "validation", ownerKey: "owner", handler: "echo", input: 9 })).resolves.toMatchObject({ ok: true }); await pool.close();
    } finally { clearTimeout(unlock); if (!released) { database.exec("ROLLBACK"); database.close(); } await rm(value, { recursive: true, force: true }); }
  }, 10_000);

  test("runs a registered handler in a terminatable Node worker", async () => {
    const value = await root();
    const pool = await createBoundedJobPool({ root: value, handlers: { echo: { module: handler, exportName: "run" } } });
    await expect(pool.submit({ kind: "validation", ownerKey: "owner-a", handler: "echo", input: { value: 3 } })).resolves.toMatchObject({ ok: true, value: { value: 3 } });
    await pool.close();
    await rm(value, { recursive: true, force: true });
  });

  test("reuses a registered worker so module-local compilation state survives jobs", async () => {
    const value = await root();
    const pool = await createBoundedJobPool({ root: value, handlers: { cached: { module: cacheHandler, exportName: "run" } } });
    const first = await pool.submit({ kind: "validation", ownerKey: "owner-a", handler: "cached", input: { n: 1 } });
    const second = await pool.submit({ kind: "validation", ownerKey: "owner-a", handler: "cached", input: { n: 2 } });
    expect(first).toMatchObject({ ok: true, value: { compileCount: 1 } });
    expect(second).toMatchObject({ ok: true, value: { compileCount: 1 } });
    await pool.close(); await rm(value, { recursive: true, force: true });
  });

  test("coordinates owner slots through SQLite and queues inclusively", async () => {
    const value = await root();
    const first = await createBoundedJobPool({ root: value, handlers: { echo: { module: handler, exportName: "run" } } });
    const second = await createBoundedJobPool({ root: value, handlers: { echo: { module: handler, exportName: "run" } } });
    const running = first.submit({ kind: "scan", ownerKey: "same", handler: "echo", input: { sleepMs: 100 } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const queued = second.submit({ kind: "scan", ownerKey: "same", handler: "echo", input: { value: "queued" }, deadlineMs: 30 });
    await expect(queued).resolves.toMatchObject({ ok: false, code: "job_queue_timeout" });
    await expect(running).resolves.toMatchObject({ ok: true });
    await first.close(); await second.close();
    await rm(value, { recursive: true, force: true });
  });

  test("deadline fence prevents a late worker result from being accepted", async () => {
    const value = await root();
    const pool = await createBoundedJobPool({ root: value, handlers: { echo: { module: handler, exportName: "run" } } });
    await expect(pool.submit({ kind: "validation", ownerKey: "owner", handler: "echo", input: { sleepMs: 200 }, deadlineMs: 30 })).resolves.toMatchObject({ ok: false, code: "job_timeout" });
    await pool.close(); await rm(value, { recursive: true, force: true });
  });

  test("host-only abort signals cancel queued work without entering worker payload", async () => {
    const value = await root();
    const pool = await createBoundedJobPool({ root: value, handlers: { echo: { module: handler, exportName: "run" } } });
    const controller = new AbortController();
    const pending = pool.submit({ kind: "scan", ownerKey: "owner", handler: "echo", input: { sleepMs: 1000 }, signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, code: "job_cancelled" });
    await pool.close(); await rm(value, { recursive: true, force: true });
  });

  test("removes listeners after every reused worker settlement", async () => {
    const value = await root();
    const originalOnce = Worker.prototype.once;
    const workers = new Set<Worker>();
    (Worker.prototype as any).once = function(event: string, callback: (...args: any[]) => void) {
      if (event === "error" || event === "exit") workers.add(this);
      return originalOnce.call(this, event, callback);
    };
    try {
      const pool = await createBoundedJobPool({ root: value, handlers: { echo: { module: handler, exportName: "run" } } });
      for (let index = 0; index < 15; index += 1) await expect(pool.submit({ kind: "validation", ownerKey: "owner", handler: "echo", input: index })).resolves.toMatchObject({ ok: true });
      for (const worker of workers) { expect(worker.listenerCount("error")).toBe(0); expect(worker.listenerCount("exit")).toBe(0); }
      await pool.close();
    } finally { Worker.prototype.once = originalOnce; await rm(value, { recursive: true, force: true }); }
  });

  test("settles a queue deadline while coordinator SQLite is locked", async () => {
    const value = await root();
    const pool = await createBoundedJobPool({ root: value, handlers: { echo: { module: handler, exportName: "run" } }, limits: { busyTimeoutMs: 100 } });
    const database = new DatabaseSync(join(value, ".tack", "state.sqlite"));
    beginImmediate(database);
    try {
      const pending = pool.submit({ kind: "validation", ownerKey: "owner", handler: "echo", input: 1, deadlineMs: 50 });
      await expect(Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve("UNSETTLED"), 300))])).resolves.toMatchObject({ ok: false, code: "job_queue_timeout" });
    } finally { database.exec("ROLLBACK"); database.close(); await pool.close(); await rm(value, { recursive: true, force: true }); }
  });

  test("rejects a success when host cancellation races coordinator fence confirmation", async () => {
    const value = await root();
    const controller = new AbortController();
    const originalPost = Worker.prototype.postMessage;
    let injected = false;
    (Worker.prototype as any).postMessage = function(message: any, ...args: any[]) {
      if (message?.operation === "current") this.prependOnceListener("message", (reply: any) => { if (reply?.id === message.id && reply.ok && reply.value === true) { injected = true; controller.abort(); } });
      return originalPost.call(this, message, ...args);
    };
    try {
      const pool = await createBoundedJobPool({ root: value, handlers: { echo: { module: handler, exportName: "run" } } });
      const result = await pool.submit({ kind: "validation", ownerKey: "owner", handler: "echo", input: 42, signal: controller.signal });
      expect(injected).toBe(true);
      expect(result).toMatchObject({ ok: false, code: "job_cancelled" });
      await pool.close();
    } finally { Worker.prototype.postMessage = originalPost; await rm(value, { recursive: true, force: true }); }
  });

  test("does not accept success after a delayed final release crosses the deadline", async () => {
    const value = await root();
    const originalPost = Worker.prototype.postMessage;
    (Worker.prototype as any).postMessage = function(message: any, ...args: any[]) {
      if (message?.operation === "release") { setTimeout(() => originalPost.call(this, message, ...args), 60); return; }
      return originalPost.call(this, message, ...args);
    };
    try {
      const pool = await createBoundedJobPool({ root: value, handlers: { echo: { module: handler, exportName: "run" } } });
      await expect(pool.submit({ kind: "validation", ownerKey: "owner", handler: "echo", input: { value: 42 }, deadlineMs: 30 })).resolves.toMatchObject({ ok: false, code: "job_timeout" });
      await pool.close();
    } finally { Worker.prototype.postMessage = originalPost; await rm(value, { recursive: true, force: true }); }
  });

  test("cancellation terminates work and close is idempotent", async () => {
    const value = await root();
    const pool = await createBoundedJobPool({ root: value, handlers: { echo: { module: handler, exportName: "run" } } });
    const pending = pool.submit({ kind: "scan", ownerKey: "owner", handler: "echo", input: { sleepMs: 1_000 } });
    // The generated opaque id is intentionally not an API capability; close is
    // the host cancellation boundary for work whose id is not retained here.
    await pool.close();
    await expect(pending).resolves.toMatchObject({ ok: false });
    await expect(pool.close()).resolves.toBeUndefined();
    await rm(value, { recursive: true, force: true });
  });
});

test("survives worker heap exhaustion and admits a subsequent job", async () => {
  const value = await root();
  const pool = await createBoundedJobPool({ root: value, handlers: { echo: { module: handler, exportName: "run" } } });
  try {
    const exhausted = await pool.submit({ kind: "validation", ownerKey: "owner", handler: "echo", input: { memoryPressure: true }, deadlineMs: 5000 });
    expect(exhausted).toMatchObject({ ok: false, code: "job_worker_error" });
    await expect(pool.submit({ kind: "validation", ownerKey: "owner", handler: "echo", input: { value: "recovered" } })).resolves.toMatchObject({ ok: true, value: { value: "recovered" } });
  } finally { await pool.close(); await rm(value, { recursive: true, force: true }); }
}, 15000);
