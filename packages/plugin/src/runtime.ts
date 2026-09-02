import {
  createTackResult,
  ownField,
  TackRuntimeError,
  type TackConfig,
  type TackResult,
  type TackRuntime,
  type TackTool
} from "@cbxss/tack-core";
import { createMcpToolRuntime } from "@cbxss/tack-mcp";

import { readPluginLayout, type PluginSkill } from "./layout.js";
import { createPluginMount } from "./mount.js";
import { readSkillData } from "./skill.js";

export interface CreatePluginToolRuntimeOptions {
  readonly config: TackConfig;
  readonly tools: readonly TackTool[];
}

type Binding =
  | { readonly kind: "skill"; readonly skill: PluginSkill; readonly exposedName: string }
  | { readonly kind: "mcp" };

/**
 * A {@link TackRuntime} for one plugin's tools. Skills are read from disk as
 * data; bundled MCP tools are delegated to a single `@cbxss/tack-mcp` runtime that
 * spans every bundled server (`@cbxss/tack-mcp` opens each connection lazily on first
 * use, so an unused bundled server is never spawned).
 */
export async function createPluginToolRuntime(
  options: CreatePluginToolRuntimeOptions
): Promise<TackRuntime> {
  const tools = ownField<readonly TackTool[]>(options, "tools") ?? [];
  const config = ownField<TackConfig>(options, "config") ?? ({ servers: {} } as TackConfig);
  const serverId = tools[0]?.serverId;
  const pluginPath = serverId
    ? ownField<string>(ownField(config.servers, serverId), "path")
    : undefined;
  const mount = pluginPath ? createPluginMount(await readPluginLayout(pluginPath)) : undefined;

  const skillByName = new Map<string, PluginSkill>();
  const mcpServers: Record<string, TackConfig["servers"][string]> = {};
  if (mount) {
    for (const { skill, name } of mount.skills) {
      skillByName.set(name, skill);
    }
    for (const { server, segment } of mount.mcpServers) {
      mcpServers[segment] = server.config;
    }
  }

  const bindingById = new Map<string, Binding>();
  const mcpTools: TackTool[] = [];
  for (const tool of tools) {
    const [group, segment] = tool.path ?? [];
    if (group === "mcp" && typeof segment === "string") {
      bindingById.set(tool.id, { kind: "mcp" });
      mcpTools.push({ ...tool, serverId: segment });
      continue;
    }
    const exposedName = group ?? tool.upstreamName;
    const skill = skillByName.get(exposedName);
    if (skill) {
      bindingById.set(tool.id, { kind: "skill", skill, exposedName });
    }
  }

  let mcpRuntime: Promise<TackRuntime> | undefined;
  const mcp = (): Promise<TackRuntime> =>
    (mcpRuntime ??= createMcpToolRuntime({
      config: { servers: mcpServers } as TackConfig,
      tools: mcpTools
    }));

  return {
    invoke: async <TStructured = unknown>(toolId: string, args: unknown): Promise<TackResult<TStructured>> => {
      const binding = bindingById.get(toolId);
      if (!binding) {
        throw new TackRuntimeError({ message: `Unknown Tack tool: ${toolId}`, toolId });
      }
      if (binding.kind === "mcp") {
        return (await mcp()).invoke<TStructured>(toolId, args);
      }
      try {
        const data = await readSkillData(binding.skill, binding.exposedName);
        return createTackResult<TStructured>({
          isError: false,
          structuredContent: data,
          content: [{ type: "text", text: JSON.stringify(data) }]
        });
      } catch (cause) {
        return createTackResult<TStructured>({
          isError: true,
          content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }]
        });
      }
    },
    close: async (): Promise<void> => {
      if (mcpRuntime) {
        await (await mcpRuntime).close();
      }
    }
  };
}
