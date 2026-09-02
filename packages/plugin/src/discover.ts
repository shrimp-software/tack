import {
  TackPluginError,
  toIdentifier,
  type DiscoveredServer,
  type DiscoveredTool,
  type PluginServerConfig,
  type TackServerConfig
} from "@tack/core";
import { discoverMcpServers } from "@tack/mcp";

import { readPluginLayout } from "./layout.js";
import { createPluginMount, type PluginMount } from "./mount.js";
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
  const mount = createPluginMount(layout);
  return {
    serverId,
    tools: [...skillTools(mount), ...(await bundledMcpTools(serverId, mount))]
  };
}

function skillTools(mount: PluginMount): DiscoveredTool[] {
  return mount.skills.map(({ skill, name }) => {
    return {
      name,
      ...(skill.description ? { description: skill.description } : {}),
      inputSchema: SKILL_INPUT_SCHEMA,
      outputSchema: SKILL_OUTPUT_SCHEMA,
      path: [name]
    };
  });
}

async function bundledMcpTools(serverId: string, mount: PluginMount): Promise<DiscoveredTool[]> {
  const groups = await Promise.all(mount.mcpServers.map(async ({ server: bundled, segment }) => {
    try {
      const [discovered] = await discoverMcpServers([[bundled.key, bundled.config]]);
      return (discovered?.tools ?? []).map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        path: ["mcp", segment, toIdentifier(tool.name, "tool")]
      }));
    } catch (cause) {
      throw new TackPluginError({
        message: `Plugin "${serverId}" bundled MCP server "${bundled.key}" failed to start`,
        cause
      });
    }
  }));
  return groups.flat();
}
