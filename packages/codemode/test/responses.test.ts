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

  it("preserves a successful upstream outcome when output validation fails", async () => {
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
    const h = host();
    h.authorize("local", manifest);
    const invoke = vi.fn(async () =>
      createTackResult({ structuredContent: { count: "wrong" }, content: [] })
    );
    const invoker = createTackToolInvoker({
      host: h,
      manifest,
      runtime: { invoke, close: async () => {} }
    });
    expect(await invoker.invoke({ path: "mock.write", args: {} })).toMatchObject({
      ok: false,
      upstreamOutcome: "succeeded",
      error: { code: "output_validation_failed" },
      responseId: expect.any(String)
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
