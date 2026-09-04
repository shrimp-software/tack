import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { formatTackError, type DiscoveredServer, type DiscoveredTool } from "@cbxss/tack-core";

import { isTackTool } from "../define.js";

export interface ModuleSourceRef {
  readonly serverId: string;
  readonly entry: string;
}

/**
 * Load a module source and turn its `defineTool()` exports into a
 * `DiscoveredServer`.
 */
export async function discoverModuleSource(ref: ModuleSourceRef): Promise<DiscoveredServer> {
  const { serverId, entry } = ref;
  const namespace = await importModule(entry);

  const tools: DiscoveredTool[] = [];
  const seen = new Set<string>();
  for (const value of Object.values(namespace)) {
    if (!isTackTool(value)) {
      continue;
    }

    if (seen.has(value.name)) {
      throw new Error(
        `Module source "${entry}" declares more than one tool named "${value.name}"`
      );
    }
    seen.add(value.name);

    tools.push({
      name: value.name,
      ...(value.description ? { description: value.description } : {}),
      ...(value.inputSchema ? { inputSchema: value.inputSchema } : {}),
      ...(value.outputSchema ? { outputSchema: value.outputSchema } : {})
    });
  }

  if (tools.length === 0) {
    throw new Error(`Module source "${entry}" exports no defineTool() tools`);
  }

  return { serverId, tools };
}

export async function importModule(entry: string): Promise<Record<string, unknown>> {
  const href = pathToFileURL(resolve(entry)).href;
  try {
    return (await import(href)) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `Failed to load module source "${entry}": ${formatTackError(cause)}`,
      { cause }
    );
  }
}
