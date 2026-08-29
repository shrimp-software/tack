import {
  buildManifest,
  TackRuntimeError,
  type SourceKind,
  type TackConfig,
  type TackManifest,
  type TackResult,
  type TackRuntime,
  type TackTool
} from "@tack/core";

import { mcpSource } from "./sources/mcp.js";
import { moduleSource } from "./sources/module.js";
import { sourceTransports, type Source, type SourceServerEntry } from "./source.js";

/** Every source the dispatcher knows. Add a new one here — nothing else changes. */
const SOURCES: readonly Source[] = [mcpSource, moduleSource];

/** The `@tack/core` source kinds behind {@link SOURCES}, for registry-driven
 *  config parsing and manifest projection. */
export const SOURCE_KINDS: readonly SourceKind[] = SOURCES.flatMap((source) => source.kinds);

const SOURCE_BY_TRANSPORT: ReadonlyMap<string, Source> = new Map(
  SOURCES.flatMap((source) => sourceTransports(source).map((transport) => [transport, source] as const))
);

/**
 * Discover every configured source and fold the results into one manifest with a
 * single {@link buildManifest} pass.
 */
export async function discoverManifest(config: TackConfig): Promise<TackManifest> {
  const entries: readonly SourceServerEntry[] = Object.entries(config.servers);
  const discovered = await Promise.all(
    SOURCES.map((source) => {
      const owned = new Set(sourceTransports(source));
      return source.discover(entries.filter(([, server]) => owned.has(server.transport)));
    })
  );
  return buildManifest(config, discovered.flat(), undefined, SOURCE_KINDS);
}

export interface CreateRuntimeOptions {
  readonly config: TackConfig;
  readonly manifest: TackManifest;
}

/**
 * Build one {@link TackRuntime} that routes each `invoke` to the source that owns
 * the tool's transport.
 */
export async function createRuntime({ config, manifest }: CreateRuntimeOptions): Promise<TackRuntime> {
  const toolsBySource = groupToolsBySource(manifest);

  const runtimeBySource = new Map(
    await Promise.all(
      [...toolsBySource].map(
        async ([source, tools]) => [source, await source.createRuntime({ config, tools })] as const
      )
    )
  );

  const routes = new Map<string, TackRuntime>();
  for (const [source, tools] of toolsBySource) {
    const runtime = runtimeBySource.get(source);
    if (!runtime) {
      continue;
    }
    for (const tool of tools) {
      routes.set(tool.id, runtime);
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

function groupToolsBySource(manifest: TackManifest): Map<Source, TackTool[]> {
  const grouped = new Map<Source, TackTool[]>();
  for (const tool of Object.values(manifest.tools)) {
    const transport = manifest.servers[tool.serverId]?.transport;
    const source = transport ? SOURCE_BY_TRANSPORT.get(transport) : undefined;
    if (!source) {
      continue;
    }
    const bucket = grouped.get(source);
    if (bucket) {
      bucket.push(tool);
    } else {
      grouped.set(source, [tool]);
    }
  }
  return grouped;
}
