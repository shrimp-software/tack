import { afterEach, describe, expect, it, vi } from "vitest";
import { buildManifest, createTackResult } from "@cbxss/tack-core";
import { createTackToolInvoker, ExecutionHost } from "../src/index.js";
import { fakeRuntime, grafanaManifest } from "../../core/test/fixtures.js";

const hosts: ExecutionHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});
function host() {
  const h = new ExecutionHost();
  hosts.push(h);
  h.authorize("local", grafanaManifest());
  return h;
}
const path = "grafana.datasources.list";

describe("downstream call delivery", () => {
  it("returns the full value as data with a retained responseId", async () => {
    const h = host();
    const invoke = vi.fn(async () =>
      createTackResult({
        structuredContent: { created: true },
        content: [{ type: "text", text: "original" }],
        _meta: { requestId: "request-1" }
      })
    );
    const invoker = createTackToolInvoker({
      host: h,
      manifest: grafanaManifest(),
      runtime: { invoke, close: async () => {} }
    });
    const result = (await invoker.invoke({ path, args: {} })) as {
      responseId: string;
    };
    expect(result).toMatchObject({
      ok: true,
      data: { created: true },
      // a compact type-only skeleton of `data` rides along on every success
      dataShape: { created: "boolean" },
      upstreamOutcome: "succeeded"
    });
    expect(typeof result.responseId).toBe("string");
    // the raw MCP envelope never rides along in the code-mode result
    expect(JSON.stringify(result)).not.toContain("request-1");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("leaves whitespace alone by default, and unless the operation's server id is listed", async () => {
    const junky = { title: "Report   ", body: "line one  \n\n\n\n  line two\t\t\ttabbed" };
    const invoke = vi.fn(async () =>
      createTackResult({ structuredContent: junky, content: [{ type: "text", text: "irrelevant" }] })
    );

    const off = createTackToolInvoker({ host: host(), manifest: grafanaManifest(), runtime: { invoke, close: async () => {} } });
    expect(await off.invoke({ path, args: {} })).toMatchObject({ ok: true, data: junky });

    // `path` is served by the "grafana" server — listing an unrelated id is a no-op.
    const otherServer = createTackToolInvoker({
      host: host(),
      manifest: grafanaManifest(),
      runtime: { invoke, close: async () => {} },
      normalizeWhitespace: ["some-other-server"]
    });
    expect(await otherServer.invoke({ path, args: {} })).toMatchObject({ ok: true, data: junky });

    const on = createTackToolInvoker({
      host: host(),
      manifest: grafanaManifest(),
      runtime: { invoke, close: async () => {} },
      normalizeWhitespace: ["grafana"]
    });
    expect(await on.invoke({ path, args: {} })).toMatchObject({
      ok: true,
      data: { title: "Report", body: "line one\n\nline two tabbed" }
    });
  });

  it("blocks invalid input without coercion before any upstream call", async () => {
    const h = host();
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const invoker = createTackToolInvoker({
      host: h,
      manifest: grafanaManifest(),
      runtime: fakeRuntime(calls)
    });
    expect(await invoker.invoke({ path, args: { extra: true } })).toMatchObject({
      ok: false,
      upstreamOutcome: "not_started",
      error: { code: "input_validation_failed" }
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    { withHost: false, validation: "failed" },
    { withHost: true, validation: "failed" },
    { withHost: true, validation: "unavailable" },
    { withHost: true, validation: "throws" }
  ])("delivers successful data when output validation is $validation (host: $withHost)", async ({ withHost, validation }) => {
    const manifest = buildManifest(
      { servers: { mock: { transport: "stdio", command: "mock" } } },
      [
        {
          serverId: "mock",
          tools: [
            {
              name: "write",
              inputSchema: { type: "object" },
              outputSchema: {
                type: "object",
                properties: { count: { type: "number" } },
                required: ["count"]
              }
            }
          ]
        }
      ]
    );
    const h = withHost ? host() : undefined;
    h?.authorize("local", manifest);
    if (h && validation !== "failed") {
      const validate = h.validate.bind(h);
      vi.spyOn(h, "validate").mockImplementation(async (owner, job, signal) => {
        if (job.purpose !== "output") return validate(owner, job, signal);
        if (validation === "throws") throw new Error("validator offline");
        return {
          status: "unavailable",
          validator: "none",
          coverage: { assertions: "not_performed", schemaSupport: "unknown", localRefs: false, remoteRefs: false, formatAssertions: false },
          diagnostics: [{ code: "output_validation_unavailable", message: "validator offline" }]
        };
      });
    }
    const retain = h ? vi.spyOn(h, "retain") : undefined;
    const onAuditEvent = vi.fn();
    const invoke = vi.fn(async () =>
      createTackResult({ structuredContent: { count: "wrong" }, content: [] })
    );
    const invoker = createTackToolInvoker({
      host: h,
      manifest,
      runtime: { invoke, close: async () => {} },
      onAuditEvent
    });
    const result = await invoker.invoke({ path: "mock.write", args: {} });
    expect(result).toMatchObject({
      ok: true,
      data: { count: "wrong" },
      dataShape: { count: "string" },
      upstreamOutcome: "succeeded",
      responseId: withHost ? expect.any(String) : null
    });
    expect(result).not.toHaveProperty("error");
    expect(onAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ ok: true, upstreamOutcome: "succeeded" }));
    if (retain) {
      expect(retain).toHaveBeenCalledWith("local", { count: "wrong" }, expect.objectContaining({
        evidence: expect.objectContaining({
          outputValidation: expect.objectContaining({
            status: validation === "failed" ? "failed" : "unavailable",
            diagnostics: expect.any(Array)
          })
        })
      }));
    }
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("still fails when the upstream tool reports an error", async () => {
    const invoke = vi.fn(async () => createTackResult({
      isError: true,
      content: [{ type: "text", text: "write rejected" }]
    }));
    const invoker = createTackToolInvoker({
      host: host(),
      manifest: grafanaManifest(),
      runtime: { invoke, close: async () => {} }
    });
    expect(await invoker.invoke({ path, args: {} })).toMatchObject({
      ok: false,
      upstreamOutcome: "failed",
      error: { code: "tool_error", message: "write rejected" }
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("still delivers data when audit retention fails", async () => {
    const h = host();
    vi.spyOn(h, "retain").mockRejectedValueOnce(new Error("disk full"));
    const invoker = createTackToolInvoker({
      host: h,
      manifest: grafanaManifest(),
      runtime: fakeRuntime([])
    });
    expect(await invoker.invoke({ path, args: {} })).toMatchObject({
      ok: true,
      upstreamOutcome: "succeeded"
    });
  });

  it("gates the live call on current owner and policy", async () => {
    const h = host();
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const invoker = createTackToolInvoker({
      host: h,
      manifest: grafanaManifest(),
      runtime: fakeRuntime(calls)
    });
    expect(await invoker.invoke({ path, args: {} })).toMatchObject({ ok: true });
    h.authorize("local", grafanaManifest(), { deniedOperations: [path] });
    expect(await invoker.invoke({ path, args: {} })).toMatchObject({
      ok: false,
      upstreamOutcome: "not_started",
      error: { code: "operation_denied" }
    });
    expect(calls).toHaveLength(1);
  });

  it("does not dispatch a cancelled call", async () => {
    const h = host();
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const invoker = createTackToolInvoker({
      host: h,
      manifest: grafanaManifest(),
      runtime: fakeRuntime(calls)
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      invoker.invoke({ path, args: {}, signal: controller.signal })
    ).resolves.toMatchObject({
      ok: false,
      upstreamOutcome: "not_started",
      error: { code: "validation_unavailable" }
    });
    expect(calls).toHaveLength(0);
  });

  it("preserves JSON null instead of its text encoding", async () => {
    const h = host();
    const invoker = createTackToolInvoker({
      host: h,
      manifest: grafanaManifest(),
      runtime: {
        invoke: async () =>
          createTackResult({ content: [{ type: "text", text: "null" }] }),
        close: async () => {}
      }
    });
    expect(await invoker.invoke({ path, args: {} })).toMatchObject({
      ok: true,
      data: null
    });
  });
});
