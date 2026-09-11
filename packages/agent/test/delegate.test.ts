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
          ? { ok: false, emitted: [], logs: [], error: { phase: "runtime", code: "internal_error", message: "boom is not defined" } }
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
      execute: async () => ({ ok: false, emitted: [], logs: [], error: { phase: "runtime", code: "internal_error", message: "nope" } }),
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
