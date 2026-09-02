import { describe, expect, it } from "vitest";

import type { PluginBundledMcpServer, PluginSkill } from "../src/layout.js";
import { resolveServerSegments, resolveSkillNames } from "../src/names.js";

function skill(name: string): PluginSkill {
  return { name, dir: `/x/${name}`, skillMdPath: `/x/${name}/SKILL.md` };
}

function server(key: string): PluginBundledMcpServer {
  return { key, config: { transport: "stdio", command: "x" } };
}

describe("resolveSkillNames", () => {
  it("suffixes reserved skill names and de-dupes collisions", () => {
    const skills = [skill("mcp"), skill("then"), skill("greet"), skill("greet")];
    const names = [...resolveSkillNames(skills).values()];
    expect(names).toEqual(["mcp_", "then_", "greet", "greet2"]);
  });
});

describe("resolveServerSegments", () => {
  it("identifier-normalises keys and de-dupes", () => {
    const servers = [server("gh-api"), server("gh api")];
    expect([...resolveServerSegments(servers).values()]).toEqual(["ghApi", "ghApi2"]);
  });

  it("rejects a bundled server that would be an unreachable middle segment", () => {
    expect(() => resolveServerSegments([server("then")])).toThrow(/reserved path segment/);
  });
});
