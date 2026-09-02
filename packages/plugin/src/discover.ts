import {
  TackPluginError,
  toIdentifier,
  type DiscoveredServer,
  type DiscoveredTool,
  type PluginServerConfig,
  type TackServerConfig
} from "@tack/core";
import { discoverMcpServers } from "@tack/mcp";

import { readPluginLayout, type PluginLayout } from "./layout.js";
import { resolveServerSegments, resolveSkillNames } from "./names.js";
import { SKILL_INPUT_SCHEMA, SKILL_OUTPUT_SCHEMA } from "./skill.js";

type Entry = readonly [serverId: string, config: TackServerConfig];

/**
 * One {@link DiscoveredServer} per `plugin` source. Skills become tools at path
 * `[<skill>]`; each bundled MCP server's tools land at `["mcp", <server>, <op>]`.
 * Overlapping leaves are left for `listOperations`' `uniquePath` to de-dupe.
 */
export function discoverPluginServers(entries: readonly Entry[]): Promise<DiscoveredServer[]> {
  return Promise.all(
    entries.map(([serverId, config]) => discoverOne(serverId, config as PluginServerConfig))
  );
}

async function discoverOne(serverId: string, config: PluginServerConfig): Promise<DiscoveredServer> {
  const layout = await readPluginLayout(config.path);
  return {
    serverId,
    tools: [...skillTools(layout), ...(await bundledMcpTools(serverId, layout))]
  };
}

function skillTools(layout: PluginLayout): DiscoveredTool[] {
  const names = resolveSkillNames(layout.skills);
  return layout.skills.map((skill) => {
    const name = names.get(skill)!;
    return {
      name,
      ...(skill.description ? { description: skill.description } : {}),
      inputSchema: SKILL_INPUT_SCHEMA,
      outputSchema: SKILL_OUTPUT_SCHEMA,
      path: [name]
    };
  });
}

async function bundledMcpTools(serverId: string, layout: PluginLayout): Promise<DiscoveredTool[]> {
  const segments = resolveServerSegments(layout.mcpServers);
  const out: DiscoveredTool[] = [];

  for (const bundled of layout.mcpServers) {
    const segment = segments.get(bundled)!;
    let discovered: DiscoveredServer[];
    try {
      discovered = await discoverMcpServers([[bundled.key, bundled.config]]);
    } catch (cause) {
      throw new TackPluginError({
        message: `Plugin "${serverId}" bundled MCP server "${bundled.key}" failed to start`,
        cause
      });
    }

    for (const tool of discovered[0]?.tools ?? []) {
      out.push({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        path: ["mcp", segment, toIdentifier(tool.name, "tool")]
      });
    }
  }

  return out;
}
