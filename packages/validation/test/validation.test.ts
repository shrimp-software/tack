import { describe, expect, it } from "vitest";

import {
  ValidationKernel,
  createValidationWorkerRunner,
  handleValidationWorkerRequest,
  inspectSchema,
  runValidationJob,
  type ValidationJob
} from "../src/index.js";

const objectSchema = {
  type: "object",
  properties: { count: { type: "number" } },
  required: ["count"],
  additionalProperties: false
} as const;

function job(overrides: Partial<ValidationJob>): ValidationJob {
  return {
    purpose: "input",
    schema: objectSchema,
    value: { count: 1 },
    sourceRevision: "source-real",
    effectiveRevision: "effective-real",
    ...overrides
  };
}

describe("ValidationKernel", () => {
  it("uses separate dialect instances and reuses the cache by actual schema hash", () => {
    const kernel = new ValidationKernel();
    const draft07 = { ...objectSchema, $schema: "https://json-schema.org/draft-07/schema#" };
    const first = kernel.validate(job({ schema: draft07 }));
    const second = kernel.validate(job({ schema: structuredClone(draft07), value: { count: 2 } }));
    const twenty = kernel.validate(job({ schema: objectSchema }));

    expect(first.status).toBe("passed");
    expect(second.status).toBe("passed");
    expect(twenty.status).toBe("passed");
    expect(first.dialect).toBe("draft-07");
    expect(twenty.dialect).toBe("2020-12");
    expect(first.effectiveContractHash).toBe(second.effectiveContractHash);
    expect(kernel.compileCount).toBe(2);
    expect(kernel.cacheSize("draft-07")).toBe(1);
    expect(kernel.cacheSize("2020-12")).toBe(1);
  });

  it("does not coerce, default, or remove input data", () => {
    const kernel = new ValidationKernel();
    const schema = {
      type: "object",
      properties: {
        count: { type: "number", default: 7 },
        name: { type: "string" }
      },
      required: ["count"],
      additionalProperties: false
    };
    const value = { count: "7", extra: "secret-value" };
    const result = kernel.validate(job({ schema, value }));

    expect(result.status).toBe("failed");
    expect(value).toEqual({ count: "7", extra: "secret-value" });
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("\"7\"");
  });

  it("never turns a known invalid assertion into success in permissive mode", () => {
    const kernel = new ValidationKernel();
    const result = kernel.validate(job({ schema: { type: "number" }, value: "not-a-number", mode: "permissive" }));

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("validation_failed");
  });

  it("supports local refs but rejects remote refs without loading them", () => {
    const kernel = new ValidationKernel();
    const local = {
      $defs: { count: { type: "number" } },
      type: "object",
      properties: { count: { $ref: "#/$defs/count" } },
      required: ["count"]
    };
    const remote = { type: "object", properties: { value: { $ref: "https://example.test/schema" } } };

    expect(kernel.validate(job({ schema: local })).status).toBe("passed");
    expect(kernel.validate(job({ schema: remote })).status).toBe("unavailable");
    expect(kernel.validate(job({ schema: remote, mode: "permissive" })).status).toBe("skipped");
    expect(kernel.validate(job({ schema: remote })).diagnostics[0]?.code).toBe("external_ref_unsupported");
  });

  it("treats formats as annotations and records the disabled assertion coverage", () => {
    const kernel = new ValidationKernel();
    const schema = { type: "string", format: "date-time" };
    const result = kernel.validate(job({ schema, value: "not-a-date" }));

    expect(result.status).toBe("passed");
    expect(result.coverage.formatAssertions).toBe(false);
    expect(result.coverage.assertions).toBe("performed");
    expect(inspectSchema(schema).hasFormat).toBe(true);
  });

  it("distinguishes unsupported dialects and unsupported assertions", () => {
    const kernel = new ValidationKernel();
    const dialect = kernel.validate(job({ schema: { $schema: "https://example.test/draft-x", type: "string" }, value: "x" }));
    const keyword = kernel.validate(job({ schema: { type: "string", xUnknownAssertion: true }, value: "x" }));

    expect(dialect.status).toBe("unavailable");
    expect(dialect.diagnostics[0]?.code).toBe("unsupported_dialect");
    expect(keyword.status).toBe("unavailable");
    expect(keyword.diagnostics[0]?.code).toBe("schema_compile_failed");
  });

  it("keeps missing input partial and missing output unavailable", () => {
    const kernel = new ValidationKernel();
    const input = kernel.validate(job({ schema: undefined, value: { any: true } }));
    const badInput = kernel.validate(job({ schema: undefined, value: [] }));
    const output = kernel.validate(job({ purpose: "output", schema: undefined, value: { any: true } }));

    expect(input.status).toBe("partial");
    expect(input.coverage.schemaSupport).toBe("missing");
    expect(badInput.status).toBe("failed");
    expect(output.status).toBe("unavailable");
    expect(output.validator).toBe("none");
    expect(output.effectiveContractHash).toBeUndefined();
  });

  it("does not invoke schema accessors while taking the kernel snapshot", () => {
    const kernel = new ValidationKernel();
    let invoked = false;
    const schema = { type: "string" } as Record<string, unknown>;
    Object.defineProperty(schema, "description", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "secret";
      }
    });

    expect(kernel.validate(job({ schema, value: "ok" })).status).toBe("passed");
    expect(invoked).toBe(false);
  });

  it("bounds value-free diagnostics", () => {
    const kernel = new ValidationKernel();
    const hugeName = "field_".repeat(1_000);
    const result = kernel.validate(job({
      schema: { type: "object", properties: { [hugeName]: { type: "string" } }, required: [hugeName] },
      value: { password: "do-not-echo" }
    }));
    const diagnostic = result.diagnostics[0];

    expect(result.status).toBe("failed");
    expect(new TextEncoder().encode(JSON.stringify(diagnostic)).byteLength).toBeLessThanOrEqual(2 * 1024);
    expect(JSON.stringify(result)).not.toContain("do-not-echo");
  });
});

describe("worker handler and runner", () => {
  it("handles a validation job without exposing job authority in the worker result", () => {
    const response = handleValidationWorkerRequest({
      type: "validate",
      requestId: "req-1",
      jobJson: JSON.stringify(job({ value: { count: 3 } }))
    });

    expect(response.type).toBe("validated");
    if (response.type === "validated") {
      expect(response.requestId).toBe("req-1");
      const result = JSON.parse(response.resultJson) as Record<string, unknown>;
      expect(result.status).toBe("passed");
      expect(result).not.toHaveProperty("jobId");
      expect(result).not.toHaveProperty("ownerKey");
    }
  });

  it("reuses the worker kernel cache for repeated same-schema jobs", () => {
    const cacheSchema = { type: "object", properties: { cacheProbe: { type: "integer" } }, required: ["cacheProbe"] };
    const before = handleValidationWorkerRequest({ type: "stats", requestId: "before" });
    expect(before.type).toBe("stats");
    if (before.type !== "stats") return;
    for (const value of [1, 2]) {
      const response = handleValidationWorkerRequest({
        type: "validate",
        requestId: `cache-${value}`,
        jobJson: JSON.stringify({ purpose: "input", schema: cacheSchema, value: { cacheProbe: value } })
      });
      expect(response.type).toBe("validated");
    }
    const after = handleValidationWorkerRequest({ type: "stats", requestId: "after" });
    expect(after.type).toBe("stats");
    if (after.type === "stats") {
      expect(after.compileCount).toBe(before.compileCount + 1);
      expect(after.cacheSize).toBe(before.cacheSize + 1);
    }
  });

  it("adapts through BoundedJobPool.submit without sending authority metadata", async () => {
    let submitted: Record<string, unknown> | undefined;
    const runner = createValidationWorkerRunner({
      jobs: {
        async submit(request) {
          submitted = request as unknown as Record<string, unknown>;
          return { ok: true, jobId: "pool-owned-job", value: runValidationJob(request.input) };
        }
      }
    });
    const result = await runner.run(job({ value: { count: 4 } }), {
      ownerKey: "local-owner"
    });

    expect(result.status).toBe("passed");
    expect(result.sourceRevision).toBe("source-real");
    expect(result.effectiveRevision).toBe("effective-real");
    expect(submitted).toMatchObject({ kind: "validation", ownerKey: "local-owner", handler: "trusted-validation" });
    expect(submitted).not.toHaveProperty("deadlineMs");
    expect(submitted).not.toHaveProperty("jobId");
    expect(submitted).not.toHaveProperty("nonce");
    expect(submitted).not.toHaveProperty("fence");
    expect(submitted?.input).not.toHaveProperty("sourceRevision");
    expect(submitted?.input).not.toHaveProperty("effectiveRevision");
  });

  it("keeps the AbortSignal host-only while accepting an omitted deadline", async () => {
    const controller = new AbortController();
    let submitted: Record<string, unknown> | undefined;
    const runner = createValidationWorkerRunner({
      jobs: {
        async submit(request) {
          submitted = request as unknown as Record<string, unknown>;
          return { ok: true, jobId: "pool-owned-job", value: runValidationJob(request.input) };
        }
      }
    });
    const result = await runner.run(job({ value: { count: 6 } }), {
      ownerKey: "local-owner",
      signal: controller.signal
    });

    expect(result.status).toBe("passed");
    expect(submitted?.signal).toBe(controller.signal);
    expect(submitted?.input).not.toHaveProperty("signal");
    expect(submitted).not.toHaveProperty("deadlineMs");
  });

  it("whitelists worker evidence instead of spreading returned metadata", async () => {
    const runner = createValidationWorkerRunner({
      jobs: {
        async submit(request) {
          return {
            ok: true,
            jobId: "pool-owned-job",
            value: {
              ...runValidationJob(request.input),
              jobId: "forged-job",
              ownerKey: "forged-owner",
              nonce: "forged-nonce",
              arbitrary: "discard-me"
            }
          };
        }
      }
    });
    const result = await runner.run(job({ value: { count: 5 } }), { ownerKey: "local-owner" });

    expect(result.status).toBe("passed");
    expect(result).not.toHaveProperty("jobId");
    expect(result).not.toHaveProperty("ownerKey");
    expect(result).not.toHaveProperty("nonce");
    expect(result).not.toHaveProperty("arbitrary");
  });

  it("maps pool cancellation without retrying", async () => {
    let calls = 0;
    const runner = createValidationWorkerRunner({
      jobs: {
        async submit() {
          calls += 1;
          return { ok: false, code: "job_cancelled", jobId: "pool-owned-job", message: "cancelled" };
        }
      }
    });
    const result = await runner.run(job({ value: { count: 4 } }), {
      ownerKey: "local-owner",
      deadlineMs: 5_000
    });

    expect(result.status).toBe("unavailable");
    expect(result.diagnostics[0]?.code).toBe("validation_cancelled");
    expect(calls).toBe(1);
  });
});
