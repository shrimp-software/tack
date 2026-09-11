import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_CONTRACTS } from "@cbxss/tack-core";
import { ExecutionHost, type CodeRuntime, type OperationPolicy } from "@cbxss/tack-codemode";
import { createQuickJSRuntime } from "@cbxss/tack-runtime-quickjs";
import { createWorkerdRuntime } from "../../runtime-workerd/src/index.js";
import { createTypeChecker } from "@cbxss/tack-typecheck";
import { fakeRuntime, grafanaManifest } from "../../core/test/fixtures.js";
import { createTackAgentServer } from "../src/index.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function connect(codeRuntime = createQuickJSRuntime({ timeoutMs: 5000 }), policy?: OperationPolicy) {
  const manifest = grafanaManifest();
  const calls: Array<{ toolId: string; args: unknown }> = [];
  const host = new ExecutionHost(); cleanup.push(() => host.close());
  const server = createTackAgentServer({ manifest, runtime: fakeRuntime(calls), codeRuntime, host, policy,
    typecheck: { checker: createTypeChecker({ manifest, ...(policy ? { policy } : {}) }), mode: "error" } });
  const client = new Client({ name: "overhaul-test", version: "2.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  cleanup.push(async () => { await client.close(); await server.close(); });
  const execute = async (code: string, typecheck?: "strict" | "off") => {
    const result = await client.callTool({ name: "execute", arguments: { code, ...(typecheck ? { typecheck } : {}) } });
    return { ...result, structuredContent: result.structuredContent as Record<string, unknown> };
  };
  return { client, calls, host, execute };
}

describe.each([
  ["quickjs", () => createQuickJSRuntime({ timeoutMs: 5000 })],
  ["workerd", () => createWorkerdRuntime({ timeoutMs: 5000 })]
] as const)("execute MCP via %s", (_name, runtime) => {
  it("exposes only execute; every cell runs fresh", async () => {
    const { client, execute } = await connect(runtime());
    const listed = await client.listTools();
    expect(listed.tools.map(t => t.name)).toEqual(["execute"]);
    expect(JSON.stringify(listed)).not.toContain("Scope persists");
    const first = await execute("const local = 41; return local;");
    expect(first.structuredContent).toMatchObject({ status: "completed", result: 41 });
    expect(first.structuredContent).not.toHaveProperty("delivery");
    expect((await execute("return typeof local;")).structuredContent).toMatchObject({ result: "undefined" });
    // the removed saved-response / inspection builtins fail as unknown operations
    const removed = await execute('return [await tools.responses.read({id:"x"}), await tools.executions.inspect({id:"y"})];');
    expect(removed.structuredContent!.result).toMatchObject([
      { ok: false, error: { code: "unknown_operation" } },
      { ok: false, error: { code: "unknown_operation" } }
    ]);
  });

  it("runs discovery and typed calls without a guide round trip", async () => {
    const { execute, calls } = await connect(runtime());
    const result = await execute(`
      const found = await tools.search({query:'datasources'});
      if (!found.ok) throw new Error(found.error.message);
      const response = await tools.grafana.datasources.list({});
      if (!response.ok) throw new Error(response.error.message);
      return {found, ok:response.ok, hasData:response.data !== undefined};
    `, "strict");
    // default search items carry inputSchema + example (callable), not TypeScript
    expect(result.structuredContent).toMatchObject({ status: "completed", result: { ok: true, hasData: true, found: { items: [{ kind: "tool", inputSchema: expect.any(Object), example: expect.any(String) }] } } });
    expect((result.structuredContent!.result as { found: { items: Array<Record<string, unknown>> } }).found.items[0]).not.toHaveProperty("inputTypeScript");
    expect(calls).toHaveLength(1);
    const found = (result.structuredContent!.result as { found: unknown }).found;
    expect(BUILTIN_CONTRACTS.search.output.safeParse(found).success).toBe(true);
  });

  it("bounds Unicode and escaped output on the actual wire, truncating an oversized return", async () => {
    const { execute } = await connect(runtime());
    const result = await execute(`emit('😀'.repeat(5000)); console.log('\\"'.repeat(20000)); return Array.from({length:1000}, (_,i)=>({i,payload:'\\"😀'.repeat(50)}));`);
    expect(result.structuredContent).toMatchObject({ status: "completed", resultTruncated: true, receiptId: expect.any(String) });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32768);
    // an oversized array keeps whole leading elements + a count, not a clipped string
    const clipped = result.structuredContent!.result as { truncated: boolean; shown: number; total: number; items: Array<{ i: number }> };
    expect(clipped).toMatchObject({ truncated: true, total: 1000 });
    expect(clipped.items.length).toBe(clipped.shown);
    expect(clipped.items[0]).toMatchObject({ i: 0 });

    // an oversized object keeps whole leading keys and names the omitted ones
    const obj = await execute(`const big = (n) => Array.from({length:n}, (_,i)=>({i, pad:'\\"😀'.repeat(40)})); return { window:{a:1}, first: big(60), second: big(600), third: big(600) };`);
    const keyed = obj.structuredContent!.result as { truncated: boolean; shownKeys: number; totalKeys: number; kept: Record<string, unknown>; omitted: string[] };
    expect(obj.structuredContent).toMatchObject({ resultTruncated: true });
    expect(keyed).toMatchObject({ truncated: true, totalKeys: 4 });
    expect(Object.keys(keyed.kept).length).toBe(keyed.shownKeys);
    expect(keyed.kept).toHaveProperty("window");
    expect(keyed.omitted.length).toBe(4 - keyed.shownKeys);
    expect([...Object.keys(keyed.kept), ...keyed.omitted].sort()).toEqual(["first", "second", "third", "window"]);
  });

  it("keeps runtime validation mandatory with typechecking off", async () => {
    const { execute, calls } = await connect(runtime());
    const result = await execute("return await tools.grafana.datasources.list({unexpected:true});", "off");
    expect(result.structuredContent).toMatchObject({ result: { ok: false, upstreamOutcome: "not_started", error: { code: "input_validation_failed" } } });
    expect(calls).toHaveLength(0);
    expect((await execute("return await tools.grafana.datasources.list(null);", "off")).structuredContent).toMatchObject({ result: { ok: false, upstreamOutcome: "not_started", error: { code: "input_validation_failed" } } });
    expect((await execute("return await tools.call('grafana.datasources.list',null);", "off")).structuredContent).toMatchObject({ result: { ok: false, upstreamOutcome: "not_started", error: { code: "input_validation_failed" } } });
    expect(calls).toHaveLength(0);
  });
});

describe("MCP contracts", () => {
  it("uses a uniform namespace envelope and rejects stale discovery revisions", async () => {
    const { execute } = await connect();
    expect((await execute("return await tools.search({});")).structuredContent).toMatchObject({ result: { revision: expect.any(String), items: [{ kind: "namespace", path: "grafana", operations: 3 }], total: 1, hasMore: false, nextOffset: null } });
    expect((await execute("return await tools.search({revision:'old'});")).structuredContent).toMatchObject({ result: { ok: false, error: { message: expect.stringContaining("catalog_revision_changed") } } });
    expect((await execute("return await tools.search({limit:'2'});")).structuredContent).toMatchObject({ result: { ok: false } });
  });

  it("typechecks both the advertised search pattern and ordinary ok guards", async () => {
    const { execute } = await connect();
    expect((await execute("const {items} = await tools.search({query:'datasources'}); return items[0].path;", "strict")).structuredContent).toMatchObject({ status: "completed", result: "grafana.datasources.list" });
    expect((await execute("const found = await tools.search({query:'datasources'}); if (!found.ok) throw new Error(found.error.message); return found.items.length;", "strict")).structuredContent).toMatchObject({ status: "completed", result: 1 });
    expect((await execute("return await tools.search({revision:'old'});")).structuredContent).toMatchObject({ result: { ok: false, items: [], hasMore: false, nextOffset: null } });
  });

  it("filters discovery, descriptions and invocation by policy", async () => {
    const { execute, calls } = await connect(undefined, { deniedOperations: ["grafana.alerting.*"] });
    const result = await execute(`return {search:await tools.search({namespace:'grafana'}),description:await tools.describe.tool({path:'grafana.alerting.rules.list'}),call:await tools.grafana.alerting.rules.list({})};`);
    expect(result.structuredContent).toMatchObject({ result: { search: { total: 1 }, description: { error: { code: "tool_not_found" } }, call: { ok: false, error: { code: "operation_denied" } } } });
    expect(calls).toHaveLength(0);
  });

  it("defaults semantic checking off and bounds explicit strict diagnostics", async () => {
    const { execute, calls } = await connect();
    expect((await execute("const x: number = 'text'; return x;")).structuredContent).toMatchObject({ result: "text" });
    const code = Array.from({ length: 50 }, (_, i) => `const x${i}: number = 'text';`).join("\n");
    const result = await execute(code, "strict");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { phase: "typecheck" } });
    const diagnostics = result.structuredContent!.typeDiagnostics as unknown[];
    expect(diagnostics.length).toBeLessThanOrEqual(3);
    expect(Buffer.byteLength(JSON.stringify(diagnostics))).toBeLessThanOrEqual(2048);
    expect(typeof result.structuredContent!.receiptId).toBe("string");
    expect(calls).toHaveLength(0);
  });

  it("bounds unexpected host failures without claiming that writes were rolled back", async () => {
    const broken: CodeRuntime = { name: "test", isolation: "none", execute: async () => { throw new Error('"'.repeat(20000)); } };
    const { execute } = await connect(broken);
    const result = await execute("return 1;");
    expect(result.isError).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32768);
    expect(JSON.stringify(result)).toContain("do not automatically replay");
  });
});
