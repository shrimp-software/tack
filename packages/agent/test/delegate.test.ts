import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuickJSRuntime } from "@cbxss/tack-runtime-quickjs";
import { fakeRuntime, grafanaManifest } from "../../core/test/fixtures.js";

import {
  createAnthropicPlanner,
  createTackAgentServer,
  extractProgram,
  runDelegate,
  type DelegatePlanner
} from "../src/index.js";

/** A planner that returns each canned reply in turn, recording the inputs it saw. */
function scriptedPlanner(replies: string[]): DelegatePlanner & { inputs: unknown[] } {
  let i = 0;
  const inputs: unknown[] = [];
  const planner = (async (input) => {
    inputs.push(input);
    return replies[Math.min(i++, replies.length - 1)] ?? "";
  }) as DelegatePlanner & { inputs: unknown[] };
  planner.inputs = inputs;
  return planner;
}

const fence = (code: string): string => `Here you go:\n\n\`\`\`ts\n${code}\n\`\`\`\n`;

describe("extractProgram", () => {
  it("pulls the first fenced block and trims it", () => {
    expect(extractProgram("blah\n```ts\nreturn 1;\n```\ntrailing")).toBe("return 1;");
    expect(extractProgram("```typescript\nconst a = 1;\nreturn a;\n```")).toBe("const a = 1;\nreturn a;");
  });

  it("falls back to the whole text when there is no fence", () => {
    expect(extractProgram("  return 42;  ")).toBe("return 42;");
  });
});

describe("runDelegate", () => {
  it("returns the program result when the first attempt succeeds", async () => {
    const planner = scriptedPlanner([fence("return 1 + 2;")]);
    const outcome = await runDelegate({
      planner,
      execute: async (code) => ({ ok: true, result: `ran: ${code}`, emitted: [], logs: [] }),
      system: "sys",
      goal: "add"
    });
    expect(outcome).toMatchObject({
      status: "completed",
      result: "ran: return 1 + 2;",
      attempts: 1,
      program: "return 1 + 2;"
    });
    expect(planner.inputs).toHaveLength(1);
  });

  it("re-plans once on failure and feeds the error back", async () => {
    const planner = scriptedPlanner([fence("boom"), fence("return 5;")]);
    let call = 0;
    const outcome = await runDelegate({
      planner,
      execute: async () => {
        call += 1;
        return call === 1
          ? { ok: false, emitted: [], logs: [], error: { phase: "runtime", message: "boom is not defined" } }
          : { ok: true, result: 5, emitted: [], logs: [] };
      },
      system: "sys",
      goal: "five"
    });
    expect(outcome).toMatchObject({ status: "completed", result: 5, attempts: 2 });
    expect(planner.inputs[1]).toMatchObject({
      priorProgram: "boom",
      priorError: "runtime: boom is not defined"
    });
  });

  it("gives up after the replan budget and reports the last error", async () => {
    const planner = scriptedPlanner([fence("boom")]);
    const outcome = await runDelegate({
      planner,
      execute: async () => ({ ok: false, emitted: [], logs: [], error: { phase: "runtime", message: "nope" } }),
      system: "sys",
      goal: "fail",
      replans: 0
    });
    expect(outcome).toMatchObject({
      status: "failed",
      attempts: 1,
      error: { phase: "runtime", message: "nope" }
    });
  });
});

describe("delegate tool over MCP", () => {
  async function connect(planner?: DelegatePlanner) {
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const server = createTackAgentServer({
      manifest: grafanaManifest(),
      runtime: fakeRuntime(calls),
      codeRuntime: createQuickJSRuntime({ timeoutMs: 5_000 }),
      ...(planner ? { delegate: { planner } } : {})
    });
    const client = new Client({ name: "tack-test", version: "0.1.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { calls, client, close: () => Promise.allSettled([client.close(), server.close()]) };
  }

  it("is not registered without the delegate option", async () => {
    const { client, close } = await connect();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(["deref", "execute", "guide"]);
    } finally {
      await close();
    }
  });

  it("registers, runs the generated program, and returns its result", async () => {
    const planner = scriptedPlanner([
      fence("const r = await tools.grafana.datasources.list();\nreturn r.ok ? r.data : { failed: r.error };")
    ]);
    const { calls, client, close } = await connect(planner);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(["delegate", "deref", "execute", "guide"]);

      const res = await client.callTool({ name: "delegate", arguments: { goal: "list the datasources" } });
      expect(res.structuredContent).toMatchObject({
        status: "completed",
        attempts: 1,
        result: { toolId: "grafana.list_datasources" }
      });
      expect((res.structuredContent as { program: string }).program).toContain("tools.grafana.datasources.list()");
      expect(calls).toEqual([{ toolId: "grafana.list_datasources", args: {} }]);
    } finally {
      await close();
    }
  });

  it("re-plans when the first program throws, then succeeds", async () => {
    const planner = scriptedPlanner([
      fence("return missingReference;"),
      fence("return 'recovered';")
    ]);
    const { client, close } = await connect(planner);
    try {
      const res = await client.callTool({ name: "delegate", arguments: { goal: "recover" } });
      expect(res.structuredContent).toMatchObject({ status: "completed", attempts: 2, result: "recovered" });
      expect((planner.inputs[1] as { priorError?: string }).priorError).toContain("runtime");
    } finally {
      await close();
    }
  });

  it("reports failure (isError) once the replan budget is spent", async () => {
    const planner = scriptedPlanner([fence("return stillBroken;")]);
    const { client, close } = await connect(planner);
    try {
      const res = await client.callTool({ name: "delegate", arguments: { goal: "always fails" } });
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toMatchObject({ status: "failed" });
      expect((res.structuredContent as { error?: { phase: string } }).error?.phase).toBe("runtime");
    } finally {
      await close();
    }
  });
});

describe("createAnthropicPlanner", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the Messages API and returns the first text block", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ content: [{ type: "text", text: "```ts\nreturn 1;\n```" }] }),
      { status: 200 }
    ));
    vi.stubGlobal("fetch", fetchMock);

    const planner = createAnthropicPlanner({ model: "claude-sonnet-5", apiKey: "sk-test" });
    const text = await planner({ system: "SYS", goal: "do it" });
    expect(text).toContain("return 1;");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test");
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string) as { model: string; system: string };
    expect(body).toMatchObject({ model: "claude-sonnet-5", system: "SYS" });
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const planner = createAnthropicPlanner({ model: "m", apiKey: "k" });
    await expect(planner({ system: "s", goal: "g" })).rejects.toThrow(/401/);
  });
});
