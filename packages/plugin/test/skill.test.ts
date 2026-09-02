import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readPluginLayout } from "../src/layout.js";
import { readSkillData } from "../src/skill.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/acme-plugin/", import.meta.url));

describe("readSkillData", () => {
  it("returns instructions with frontmatter stripped and lists bundled files", async () => {
    const layout = await readPluginLayout(FIXTURE);
    const skill = layout.skills[0]!;

    const data = await readSkillData(skill, "greet");

    expect(data.name).toBe("greet");
    expect(data.description).toBe("Greet a user by name.");
    expect(data.instructions.startsWith("# Greet")).toBe(true);
    expect(data.instructions).not.toContain("---");

    expect(data.files).toEqual([
      { path: "scripts/hello.sh", bytes: expect.any(Number) }
    ]);
    expect(data.files.some((f) => f.path === "SKILL.md")).toBe(false);
  });
});
