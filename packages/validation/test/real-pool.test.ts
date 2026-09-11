import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoundedJobPool, probeRuntimeCapabilities, type BoundedJobPool, type RuntimeCapabilityStatus } from "@cbxss/tack-host-jobs";
import {
  createValidationWorkerRunner,
  VALIDATION_HANDLER_NAME,
  type ValidationJobPool,
  type ValidationJobRequest,
  type ValidationJobResult
} from "../src/index.js";

const objectSchema = {
  type: "object",
  properties: { count: { type: "number" } },
  required: ["count"],
  additionalProperties: false
} as const;
const validationHandler = new URL("../dist/worker-handler.js", import.meta.url);
const delayHandler = new URL("./delay-handler.mjs", import.meta.url);

function validationJob(value: unknown) {
  return { purpose: "input" as const, schema: objectSchema, value };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Node real BoundedJobPool validation handoff", () => {
  let pool: BoundedJobPool | undefined;
  let runner: ReturnType<typeof createValidationWorkerRunner> | undefined;
  let root: string | undefined;
  let capabilityStatus: RuntimeCapabilityStatus | undefined;

  beforeAll(async () => {
    const capability = await probeRuntimeCapabilities();
    capabilityStatus = capability.status;
    if (capability.status !== "available") return;
    root = await mkdtemp(join(tmpdir(), "tack-validation-real-"));
    pool = await createBoundedJobPool({
      root,
      runtime: "node",
      handlers: {
        [VALIDATION_HANDLER_NAME]: { module: validationHandler, exportName: "runValidationJob" },
        "validation-test-delay": { module: delayHandler, exportName: "run" }
      }
    });
    runner = createValidationWorkerRunner({ jobs: pool });
  });

  afterAll(async () => {
    await pool?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  function available(): { pool: BoundedJobPool; runner: ReturnType<typeof createValidationWorkerRunner> } | undefined {
    if (pool && runner) return { pool, runner };
    expect(["unsupported", "unverified"]).toContain(capabilityStatus);
    return undefined;
  }

  it("uses one injected pool and reuses the registered validation worker", async () => {
    const current = available();
    if (!current) return;
    const first = await current.runner.run(validationJob({ count: 1 }), { ownerKey: "validation-owner" });
    const second = await current.runner.run(validationJob({ count: 2 }), { ownerKey: "validation-owner", deadlineMs: 1_000 });

    expect(first.status).toBe("passed");
    expect(second.status).toBe("passed");
    expect(first.effectiveContractHash).toBe(second.effectiveContractHash);
  });

  it("keeps signal out of worker input on the real pool path", async () => {
    const current = available();
    if (!current) return;
    const controller = new AbortController();
    const result = await current.pool.submit({
      kind: "validation",
      ownerKey: "signal-owner",
      handler: "validation-test-delay",
      input: { probe: true },
      signal: controller.signal
    });

    expect(result).toMatchObject({ ok: true, value: { keys: ["probe"] } });
  });

  it("maps running-pool cancellation without retrying", async () => {
    const current = available();
    if (!current) return;
    const ownerKey = "cancel-owner";
    const hold = current.pool.submit({ kind: "validation", ownerKey, handler: "validation-test-delay", input: { sleepMs: 250 }, deadlineMs: 1_000 });
    await sleep(20);
    const controller = new AbortController();
    const pending = current.runner.run(validationJob({ count: 3 }), { ownerKey, deadlineMs: 1_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    await expect(pending).resolves.toMatchObject({ status: "unavailable", diagnostics: [{ code: "validation_cancelled" }] });
    await expect(hold).resolves.toMatchObject({ ok: true });
  });

  it("maps a queued pool deadline and rejects a late fenced worker result", async () => {
    const current = available();
    if (!current) return;
    const ownerKey = "deadline-owner";
    const hold = current.pool.submit({ kind: "validation", ownerKey, handler: "validation-test-delay", input: { sleepMs: 250 }, deadlineMs: 1_000 });
    await sleep(20);
    await expect(current.runner.run(validationJob({ count: 4 }), { ownerKey, deadlineMs: 25 })).resolves.toMatchObject({ status: "unavailable", diagnostics: [{ code: "validation_worker_timeout" }] });
    await expect(hold).resolves.toMatchObject({ ok: true });

    await expect(current.pool.submit({ kind: "validation", ownerKey: "fence-owner", handler: "validation-test-delay", input: { sleepMs: 250 }, deadlineMs: 25 }))
      .resolves.toMatchObject({ ok: false, code: "job_timeout" });
  });

  it("projects only validation evidence after a real pool result", async () => {
    const current = available();
    if (!current) return;
    const tamperedPool: ValidationJobPool = {
      async submit<T = unknown>(request: ValidationJobRequest): Promise<ValidationJobResult<T>> {
        const result = await current.pool.submit<T>(request);
        if (!result.ok) return result;
        return {
          ...result,
          value: {
            ...(result.value as Record<string, unknown>),
            jobId: "forged-job",
            ownerKey: "forged-owner",
            nonce: "forged-nonce",
            arbitrary: "discard-me"
          } as T
        };
      }
    };
    const tamperedRunner = createValidationWorkerRunner({ jobs: tamperedPool });
    const result = await tamperedRunner.run(validationJob({ count: 5 }), { ownerKey: "authority-owner" });

    expect(result.status).toBe("passed");
    expect(result).not.toHaveProperty("jobId");
    expect(result).not.toHaveProperty("ownerKey");
    expect(result).not.toHaveProperty("nonce");
    expect(result).not.toHaveProperty("arbitrary");
  });
});
