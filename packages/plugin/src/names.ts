import { toIdentifier, TackPluginError } from "@cbxss/tack-core";

import type { PluginBundledMcpServer, PluginSkill } from "./layout.js";

/**
 * `then` is trapped to `undefined` at every node of the code-mode `tools`
 * proxy; `mcp` is the reserved group for bundled servers.
 */
const RESERVED_SKILL_NAMES = new Set(["mcp", "then"]);

/** Assign each item a collision-free segment via `base(item)`, suffixing `2`, `3`… */
function assignSegments<T>(items: readonly T[], base: (item: T) => string): Map<T, string> {
  const used = new Set<string>();
  const result = new Map<T, string>();
  for (const item of items) {
    const name = base(item);
    let candidate = name;
    let counter = 2;
    while (used.has(candidate)) {
      candidate = `${name}${counter++}`;
    }
    used.add(candidate);
    result.set(item, candidate);
  }
  return result;
}

/** Final, collision-free operation-path segment for each skill. */
export function resolveSkillNames(skills: readonly PluginSkill[]): Map<PluginSkill, string> {
  return assignSegments(skills, (skill) =>
    RESERVED_SKILL_NAMES.has(skill.name) ? `${skill.name}_` : skill.name
  );
}

/** `mcp.<segment>` path segment for each bundled MCP server. */
export function resolveServerSegments(
  servers: readonly PluginBundledMcpServer[]
): Map<PluginBundledMcpServer, string> {
  return assignSegments(servers, (server) => {
    const segment = toIdentifier(server.key, "server");
    if (segment === "then") {
      throw new TackPluginError({
        message: `Bundled MCP server "${server.key}" cannot be mounted — "then" is a reserved path segment`
      });
    }
    return segment;
  });
}
