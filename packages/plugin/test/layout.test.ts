import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readPluginLayout } from "../src/layout.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/acme-plugin/", import.meta.url));

let tmp: string | undefined;
afterEach(async () => {
  if (tmp) {
    await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe("readPluginLayout", () => {
  it("reads plugin.json, skills, and bundled MCP servers from the fixture", async () => {
    const layout = await readPluginLayout(FIXTURE);

    expect(layout.manifest).toMatchObject({ name: "acme", version: "0.1.0" });
    expect(layout.skills.map((s) => s.name)).toEqual(["greet"]);
    expect(layout.skills[0]?.description).toBe("Greet a user by name.");

    expect(layout.mcpServers).toHaveLength(1);
    const bundled = layout.mcpServers[0]!;
    expect(bundled.key).toBe("echo");
    expect(bundled.config.transport).toBe("stdio");
    if (bundled.config.transport === "stdio") {
      expect(bundled.config.args?.[0]).toBe(join(layout.root, "echo-server.mjs"));
      expect(bundled.config.args?.[0]).not.toContain("${CLAUDE_PLUGIN_ROOT}");
      expect(bundled.config.cwd).toBe(layout.root);
    }
  });

  it("falls back to the directory name when SKILL.md has no frontmatter name", async () => {
    tmp = await mkdtemp(join(tmpdir(), "tack-plugin-layout-"));
    await mkdir(join(tmp, ".claude-plugin"), { recursive: true });
    await writeFile(join(tmp, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p" }));
    await mkdir(join(tmp, "skills", "no-front"), { recursive: true });
    await writeFile(join(tmp, "skills", "no-front", "SKILL.md"), "# Just a body\n");

    const layout = await readPluginLayout(tmp);
    expect(layout.skills.map((s) => s.name)).toEqual(["no-front"]);
    expect(layout.mcpServers).toEqual([]);
  });

  it("throws a TackPluginError for a missing plugin.json", async () => {
    tmp = await mkdtemp(join(tmpdir(), "tack-plugin-layout-"));
    await expect(readPluginLayout(tmp)).rejects.toThrow(/plugin\.json/);
  });
});
