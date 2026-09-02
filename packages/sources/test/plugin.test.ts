import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { TackConfig } from "@tack/core";

import { createRuntime, discoverManifest } from "../src/index.js";

const PLUGIN = fileURLToPath(
  new URL("../../plugin/test/fixtures/acme-plugin/", import.meta.url)
);

function pluginConfig(): TackConfig {
  return { servers: {}, plugins: { acme: { path: PLUGIN } } };
}

describe("plugin source", () => {
  it("desugars the plugins block into one namespace with skill + bundled MCP tools", async () => {
    const manifest = await discoverManifest(pluginConfig());

    expect(manifest.servers["acme"]).toMatchObject({ transport: "plugin" });
    expect(manifest.servers["acme"]?.pluginPath).toMatch(/acme-plugin\/?$/);

    const ids = Object.keys(manifest.tools).sort();
    expect(ids).toEqual(["acme.echo", "acme.greet"]);
    expect(manifest.tools["acme.greet"]?.path).toEqual(["greet"]);
    expect(manifest.tools["acme.echo"]?.path).toEqual(["mcp", "echo", "echo"]);
  }, 15_000);

  it("returns a skill as data and round-trips a bundled MCP call", async () => {
    const config = pluginConfig();
    const manifest = await discoverManifest(config);
    const runtime = await createRuntime({ config, manifest });

    try {
      const skill = await runtime.invoke("acme.greet", {});
      expect(skill.isError).toBe(false);
      expect(skill.json()).toMatchObject({
        name: "greet",
        description: "Greet a user by name.",
        files: [{ path: "scripts/hello.sh" }]
      });
      expect((skill.json() as { instructions: string }).instructions).toContain("# Greet");

      const echoed = await runtime.invoke("acme.echo", { text: "hi there" });
      expect(echoed.isError).toBe(false);
      expect(echoed.json()).toEqual({ text: "hi there" });
    } finally {
      await runtime.close();
    }
  }, 15_000);
});
