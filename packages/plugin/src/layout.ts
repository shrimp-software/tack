import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  TackPluginError,
  type HttpServerConfig,
  type StdioServerConfig
} from "@cbxss/tack-core";

export interface PluginJson {
  readonly name: string;
  readonly version?: string | undefined;
  readonly description?: string | undefined;
}

export interface PluginSkill {
  /** Skill name — the `skills/<dir>` name, or the SKILL.md `name:` frontmatter. */
  readonly name: string;
  readonly description?: string | undefined;
  /** Absolute path to the skill directory. */
  readonly dir: string;
  /** Absolute path to the skill's SKILL.md. */
  readonly skillMdPath: string;
}

export interface PluginBundledMcpServer {
  /** Key under `.mcp.json` `mcpServers`. */
  readonly key: string;
  readonly config: StdioServerConfig | HttpServerConfig;
}

export interface PluginLayout {
  readonly root: string;
  readonly manifest: PluginJson;
  readonly skills: readonly PluginSkill[];
  readonly mcpServers: readonly PluginBundledMcpServer[];
}

/** Read a plugin's own layout: `.claude-plugin/plugin.json`, `skills/`, `.mcp.json`. */
export async function readPluginLayout(root: string): Promise<PluginLayout> {
  const absRoot = resolve(root);
  await assertDir(absRoot, `Plugin root "${root}" is not a directory`);

  return {
    root: absRoot,
    manifest: await readPluginJson(absRoot),
    skills: await readSkills(absRoot),
    mcpServers: await readMcpServers(absRoot)
  };
}

async function readPluginJson(root: string): Promise<PluginJson> {
  const path = join(root, ".claude-plugin", "plugin.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    throw new TackPluginError({ message: `Missing ${path}`, cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new TackPluginError({ message: `Invalid ${path}: not JSON`, cause });
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record?.["name"] !== "string" || record["name"].length === 0) {
    throw new TackPluginError({ message: `Invalid ${path}: "name" is required` });
  }

  return {
    name: record["name"],
    ...(typeof record["version"] === "string" ? { version: record["version"] } : {}),
    ...(typeof record["description"] === "string" ? { description: record["description"] } : {})
  };
}

async function readSkills(root: string): Promise<PluginSkill[]> {
  const skillsDir = join(root, "skills");
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }

  const skills: PluginSkill[] = [];
  for (const entry of entries.sort()) {
    const dir = join(skillsDir, entry);
    if (!(await isDir(dir))) {
      continue;
    }
    const skillMdPath = join(dir, "SKILL.md");
    let body: string;
    try {
      body = await readFile(skillMdPath, "utf8");
    } catch {
      continue; // a skills/ subdir with no SKILL.md is not a skill
    }

    const front = parseFrontmatter(body);
    skills.push({
      name: typeof front["name"] === "string" && front["name"].length > 0 ? front["name"] : entry,
      ...(typeof front["description"] === "string" ? { description: front["description"] } : {}),
      dir,
      skillMdPath
    });
  }
  return skills;
}

async function readMcpServers(root: string): Promise<PluginBundledMcpServer[]> {
  const path = join(root, ".mcp.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new TackPluginError({ message: `Invalid ${path}: not JSON`, cause });
  }

  const servers = (parsed as { mcpServers?: unknown })?.mcpServers;
  if (servers === undefined) {
    return [];
  }
  if (typeof servers !== "object" || servers === null) {
    throw new TackPluginError({ message: `Invalid ${path}: "mcpServers" must be an object` });
  }

  const out: PluginBundledMcpServer[] = [];
  for (const [key, serverDef] of Object.entries(servers as Record<string, unknown>)) {
    out.push({ key, config: normaliseBundledServer(key, serverDef, root, path) });
  }
  return out;
}

function normaliseBundledServer(
  key: string,
  raw: unknown,
  root: string,
  sourcePath: string
): StdioServerConfig | HttpServerConfig {
  const def = (raw ?? {}) as Record<string, unknown>;
  const sub = (value: string): string => value.split("${CLAUDE_PLUGIN_ROOT}").join(root);
  const subMap = (value: unknown): Record<string, string> | undefined => {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") {
        next[k] = sub(v);
      }
    }
    return Object.keys(next).length > 0 ? next : undefined;
  };

  if (typeof def["command"] === "string") {
    const command = sub(def["command"]);
    const args = Array.isArray(def["args"])
      ? def["args"].filter((a): a is string => typeof a === "string").map(sub)
      : undefined;
    const env = subMap(def["env"]);
    const cwdRaw = typeof def["cwd"] === "string" ? sub(def["cwd"]) : undefined;
    const cwd = cwdRaw ? (isAbsolute(cwdRaw) ? cwdRaw : resolve(root, cwdRaw)) : root;
    return {
      transport: "stdio",
      command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
      cwd
    };
  }

  if (typeof def["url"] === "string") {
    const headers = subMap(def["headers"]);
    return {
      transport: "http",
      url: sub(def["url"]),
      ...(headers ? { headers } : {})
    };
  }

  throw new TackPluginError({
    message: `Invalid ${sourcePath}: server "${key}" needs a "command" (stdio) or "url" (http)`
  });
}

/** Minimal `--- k: v ---` frontmatter reader (single-line string values only). */
function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) {
      continue;
    }
    out[kv[1]!] = unquote(kv[2]!.trim());
  }
  return out;
}

function unquote(value: string): string {
  return (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
    ? value.slice(1, -1)
    : value;
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function assertDir(path: string, message: string): Promise<void> {
  if (!(await isDir(path))) {
    throw new TackPluginError({ message });
  }
}
