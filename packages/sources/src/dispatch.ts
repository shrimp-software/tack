import {
  buildManifest,
  ownDataEntries,
  ownDataValue as ownValue,
  TackRuntimeError,
  type TackConfig,
  type TackManifest,
  type TackManifestServer,
  type TackResult,
  type TackRuntime,
  type TackTool
} from "@tack/core";

import { mcpSource } from "./sources/mcp.js";
import { moduleSource } from "./sources/module.js";
import type { Source } from "./source.js";

/** Every source kind the dispatcher knows. Add a new kind here — nothing else changes. */
const SOURCES: readonly Source[] = [mcpSource, moduleSource];

/**
 * Discover every configured source and fold the results into one manifest with a
 * single {@link buildManifest} pass.
 */
export async function discoverManifest(config: TackConfig): Promise<TackManifest> {
  const discovered = await Promise.all(SOURCES.map((source) => source.discover(config)));
  return buildManifest(config, discovered.flat());
}

export interface CreateRuntimeOptions {
  readonly config: TackConfig;
  readonly manifest: TackManifest;
}

/**
 * Build one {@link TackRuntime} that routes each `invoke` to the source that owns
 * the tool's transport.
 */
export async function createRuntime(options: CreateRuntimeOptions): Promise<TackRuntime> {
  const config = ownValue<TackConfig>(options, "config") as TackConfig;
  const manifest = ownValue<TackManifest>(options, "manifest") as TackManifest;

  const sourceByTransport = new Map<TackManifestServer["transport"], Source>();
  for (const source of SOURCES) {
    for (const transport of source.transports) {
      sourceByTransport.set(transport, source);
    }
  }

  const sourceByServer = new Map<string, Source>();
  for (const [serverId, server] of ownDataEntries<TackManifestServer>(
    ownValue<TackManifest["servers"]>(manifest, "servers")
  )) {
    const source = sourceByTransport.get(server.transport);
    if (source) {
      sourceByServer.set(serverId, source);
    }
  }

  const toolOwners = new Map<string, Source>();
  for (const [toolId, tool] of ownDataEntries<TackTool>(
    ownValue<TackManifest["tools"]>(manifest, "tools")
  )) {
    const source = sourceByServer.get(tool.serverId);
    if (source) {
      toolOwners.set(toolId, source);
    }
  }

  const runtimeBySource = new Map<Source, TackRuntime>();
  for (const source of new Set(toolOwners.values())) {
    runtimeBySource.set(source, await source.createRuntime({ config, manifest }));
  }

  const routes = new Map<string, TackRuntime>();
  for (const [toolId, source] of toolOwners) {
    const runtime = runtimeBySource.get(source);
    if (runtime) {
      routes.set(toolId, runtime);
    }
  }

  const runtimes = [...runtimeBySource.values()];

  return {
    invoke: async <TStructured = unknown>(
      toolId: string,
      args: unknown
    ): Promise<TackResult<TStructured>> => {
      const runtime = routes.get(toolId);
      if (!runtime) {
        throw new TackRuntimeError({ message: `Unknown Tack tool: ${toolId}`, toolId });
      }
      return runtime.invoke<TStructured>(toolId, args);
    },
    close: async (): Promise<void> => {
      await Promise.all(runtimes.map((runtime) => runtime.close()));
    }
  };
}
