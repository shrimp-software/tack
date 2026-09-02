import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildManifest, type TackConfig, type TackRuntime } from "@cbxss/tack-core";

import { createRuntime, defineTool, discoverManifest, isTackTool } from "../src/index.js";
import { discoverModuleSource } from "../src/module/discover.js";

const CALC_ENTRY = fileURLToPath(new URL("./fixtures/calc.ts", import.meta.url));
const EMPTY_ENTRY = fileURLToPath(new URL("./fixtures/empty.ts", import.meta.url));

function calcConfig(): TackConfig {
  return { servers: { calc: { transport: "module", entry: CALC_ENTRY } } };
}

async function calcRuntime(): Promise<TackRuntime> {
  const config = calcConfig();
  const manifest = await discoverManifest(config);
  return createRuntime({ config, manifest });
}

describe("defineTool", () => {
  it("brands definitions and converts a Zod input schema to JSON Schema", () => {
    const tool = defineTool({
      name: "echo",
      description: "echo",
      input: z.object({ value: z.string() }),
      handler: ({ value }) => value
    });

    expect(isTackTool(tool)).toBe(true);
    expect(tool.description).toBe("echo");
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"]
    });
  });

  it("passes a hand-written JSON Schema through untouched and skips validation", () => {
    const schema = { type: "object", additionalProperties: true } as const;
    const tool = defineTool({ name: "passthrough", input: schema, handler: (value: unknown) => value });

    expect(tool.inputSchema).toBe(schema);
    expect(tool.parse({ anything: true })).toEqual({ anything: true });
  });

  it("is not confused by arbitrary objects", () => {
    expect(isTackTool({})).toBe(false);
    expect(isTackTool(null)).toBe(false);
  });

  it("brands with a non-enumerable registered symbol so a foreign copy still matches", () => {
    const tool = defineTool({ name: "branded", handler: () => null });

    // Not visible to discovery's export walk or to object spread.
    expect(Object.keys(tool)).not.toContain("Symbol(tack.sources.tool)");
    expect(Object.getOwnPropertyNames(tool)).toEqual(
      expect.arrayContaining(["name", "handler"])
    );

    // A value branded by a different package copy (same registered symbol) matches.
    const foreign = { [Symbol.for("tack.sources.tool")]: true };
    expect(isTackTool(foreign)).toBe(true);
  });
});

describe("discoverModuleSource", () => {
  it("turns defineTool exports into discovered tools and ignores non-tools", async () => {
    const server = await discoverModuleSource({ serverId: "calc", entry: CALC_ENTRY });

    expect(server.serverId).toBe("calc");
    const byName = new Map(server.tools.map((tool) => [tool.name, tool]));
    expect([...byName.keys()].sort()).toEqual(["add", "boom", "noop", "shout_message"]);

    const add = byName.get("add");
    expect(add?.description).toBe("Add two numbers");
    expect(add?.inputSchema).toMatchObject({
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } }
    });
    expect(byName.get("shout_message")?.name).toBe("shout_message");
  });

  it("rejects a module that exports no tools", async () => {
    await expect(
      discoverModuleSource({ serverId: "empty", entry: EMPTY_ENTRY })
    ).rejects.toThrow(/no defineTool\(\) tools/);
  });

  it("wraps a missing entry in a descriptive error", async () => {
    await expect(
      discoverModuleSource({ serverId: "gone", entry: `${CALC_ENTRY}.missing.ts` })
    ).rejects.toThrow(/Failed to load module source/);
  });
});

describe("discoverManifest + createRuntime", () => {
  it("builds a manifest for a module source", async () => {
    const manifest = await discoverManifest(calcConfig());

    expect(Object.keys(manifest.tools)).toEqual(
      expect.arrayContaining(["calc.add", "calc.boom", "calc.shout_message"])
    );
    expect(manifest.servers["calc"]).toMatchObject({ transport: "module", entry: CALC_ENTRY });
  });

  it("invokes a module-backed tool and returns its value", async () => {
    const runtime = await calcRuntime();
    try {
      const sum = await runtime.invoke("calc.add", { a: 2, b: 3 });
      expect(sum.isError).toBe(false);
      expect(sum.json()).toEqual({ sum: 5 });

      const shouted = await runtime.invoke("calc.shout_message", { message: "hi" });
      expect(shouted.text()).toBe("HI");
    } finally {
      await runtime.close();
    }
  });

  it("represents a handler that returns nothing as an empty, non-error result", async () => {
    const runtime = await calcRuntime();
    try {
      const result = await runtime.invoke("calc.noop", {});
      expect(result.isError).toBe(false);
      expect(result.text()).toBe("");
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("defaults missing args to an empty object before validation", async () => {
    const runtime = await calcRuntime();
    try {
      const result = await runtime.invoke("calc.noop", undefined);
      expect(result.isError).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it("surfaces a handler throw as an error result, not a rejection", async () => {
    const runtime = await calcRuntime();
    try {
      const result = await runtime.invoke("calc.boom", {});
      expect(result.isError).toBe(true);
      expect(result.text()).toContain("kaboom");
    } finally {
      await runtime.close();
    }
  });

  it("surfaces invalid args as an error result via Zod validation", async () => {
    const runtime = await calcRuntime();
    try {
      const result = await runtime.invoke("calc.add", { a: "nope" });
      expect(result.isError).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("rejects an unknown tool id", async () => {
    const runtime = await calcRuntime();
    try {
      await expect(runtime.invoke("calc.missing", {})).rejects.toThrow(/Unknown Tack tool/);
    } finally {
      await runtime.close();
    }
  });

  it("routes each tool to the runtime that owns its transport", async () => {
    const config: TackConfig = {
      servers: {
        calc: { transport: "module", entry: CALC_ENTRY },
        remote: { transport: "stdio", command: "tack-nonexistent-mcp-binary" }
      }
    };
    const manifest = buildManifest(config, [
      await discoverModuleSource({ serverId: "calc", entry: CALC_ENTRY }),
      { serverId: "remote", tools: [{ name: "ping" }] }
    ]);
    const runtime = await createRuntime({ config, manifest });

    try {
      const sum = await runtime.invoke("calc.add", { a: 1, b: 1 });
      expect(sum.json()).toEqual({ sum: 2 });

      // Routed to the MCP runtime: it fails trying to spawn the (missing) server
      // rather than being reported as an unknown tool.
      const error = await runtime.invoke("remote.ping", {}).then(
        () => undefined,
        (cause: unknown) => cause
      );
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain("Unknown Tack tool");
    } finally {
      await runtime.close();
    }
  });
});
