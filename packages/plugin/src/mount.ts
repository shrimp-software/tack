import type { PluginBundledMcpServer, PluginLayout, PluginSkill } from "./layout.js";
import { resolveServerSegments, resolveSkillNames } from "./names.js";

/** A plugin layout with the stable names Tack mounts into its tool namespace. */
export interface PluginMount {
  readonly layout: PluginLayout;
  readonly skills: readonly { readonly skill: PluginSkill; readonly name: string }[];
  readonly mcpServers: readonly { readonly server: PluginBundledMcpServer; readonly segment: string }[];
}

/**
 * Resolve plugin names exactly once per consumer so discovery and runtime use
 * the same collision and reserved-name rules.
 */
export function createPluginMount(layout: PluginLayout): PluginMount {
  const skillNames = resolveSkillNames(layout.skills);
  const serverSegments = resolveServerSegments(layout.mcpServers);
  return {
    layout,
    skills: layout.skills.map((skill) => ({ skill, name: skillNames.get(skill)! })),
    mcpServers: layout.mcpServers.map((server) => ({ server, segment: serverSegments.get(server)! }))
  };
}
