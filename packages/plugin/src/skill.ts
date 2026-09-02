import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { TackPluginError, type JsonSchema } from "@tack/core";

import type { PluginSkill } from "./layout.js";

/** Input schema for a skill operation — no required args, so `tools.p.skill()` works. */
export const SKILL_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false
};

/** Output schema — an explicit shape so `describe.tool` / the ambient d.ts type it. */
export const SKILL_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "instructions", "files"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    instructions: { type: "string", description: "The SKILL.md body, with frontmatter removed." },
    files: {
      type: "array",
      description: "Every bundled file in the skill directory (SKILL.md excluded).",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "bytes"],
        properties: {
          path: { type: "string", description: "Path relative to the skill directory." },
          bytes: { type: "number" }
        }
      }
    }
  }
};

export interface SkillData {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly files: readonly { readonly path: string; readonly bytes: number }[];
}

/**
 * Load a skill as data: its instructions (SKILL.md body, frontmatter stripped)
 * and a listing of every other file under the skill directory. Nothing is
 * executed. Symlinks that escape the skill directory are refused.
 */
export async function readSkillData(skill: PluginSkill, exposedName: string): Promise<SkillData> {
  const body = await readFile(skill.skillMdPath, "utf8");
  const dirReal = await realpath(skill.dir);

  const files: { path: string; bytes: number }[] = [];
  await walk(skill.dir, dirReal, files);
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    name: exposedName,
    description: skill.description ?? "",
    instructions: stripFrontmatter(body),
    files
  };
}

async function walk(
  dir: string,
  rootReal: string,
  out: { path: string; bytes: number }[]
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);

    let real: string;
    try {
      real = await realpath(full);
    } catch {
      continue;
    }
    if (real !== rootReal && !real.startsWith(rootReal + sep)) {
      throw new TackPluginError({
        message: `Skill file "${full}" resolves outside the skill directory`
      });
    }

    const info = await stat(real);
    if (info.isDirectory()) {
      await walk(full, rootReal, out);
      continue;
    }
    if (!info.isFile()) {
      continue;
    }
    const rel = relative(rootReal, real);
    if (rel === "SKILL.md") {
      continue;
    }
    out.push({ path: rel.split(sep).join("/"), bytes: info.size });
  }
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trimStart();
}
