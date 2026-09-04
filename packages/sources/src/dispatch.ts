import {
  buildManifest,
  TackRuntimeError,
  type SourceKind,
  type TackConfig,
  type TackManifest,
  type TackResult,
  type TackRuntime,
  type TackRuntimeInvokeOptions,
  type TackTool,
  type Transport
} from "@cbxss/tack-core";
import { resolvePluginsIntoConfig } from "@cbxss/tack-plugin";

import { mcpSource } from "./sources/mcp.js";
import { moduleSource } from "./sources/module.js";
import { pluginSource } from "./sources/plugin.js";
import { sourceTransports, type Source, type SourceServerEntry } from "./source.js";

/** Every source the dispatcher knows. Add a new one here — nothing else changes. */
const SOURCES: readonly Source[] = [mcpSource, moduleSource, pluginSource];

/** Options shared by {@link discoverManifest} and {@link createRuntime}. */
export interface WorkspaceOptions {
  /**
   * Directory the config file lives in — anchors local plugin `path`s and the
   * `tack.plugins.lock` lockfile. Defaults to the process working directory.
   */
  readonly configDir?: string | undefined;
}

function prepareConfig(config: TackConfig, options?: WorkspaceOptions): Promise<TackConfig> {
  // Expand the top-level `plugins` block into synthetic `plugin` sources.
  // No-op (and cheap) when there is no `plugins` key — safe to call repeatedly.
  return resolvePluginsIntoConfig(config, { configDir: options?.configDir ?? process.cwd() });
}

/** The `@cbxss/tack-core` source kinds behind {@link SOURCES}, for registry-driven
 *  config parsing and manifest projection. */
export const SOURCE_KINDS: readonly SourceKind[] = SOURCES.flatMap((source) => source.kinds);

const SOURCE_BY_TRANSPORT: ReadonlyMap<Transport, Source> = new Map(
  SOURCES.flatMap((source) => sourceTransports(source).map((transport) => [transport, source] as const))
);

/**
 * Discover every configured source and fold the results into one manifest with a
 * single {@link buildManifest} pass.
 */
export async function discoverManifest(
  config: TackConfig,
  options?: WorkspaceOptions
): Promise<TackManifest> {
  const prepared = await prepareConfig(config, options);
  const entries: readonly SourceServerEntry[] = Object.entries(prepared.servers);
  const discovered = await Promise.all(
    SOURCES.map((source) => {
      const owned = new Set(sourceTransports(source));
      return source.discover(entries.filter(([, server]) => owned.has(server.transport)));
    })
  );
  return buildManifest(prepared, discovered.flat(), undefined, SOURCE_KINDS);
}

export interface CreateRuntimeOptions extends WorkspaceOptions {
  readonly config: TackConfig;
  readonly manifest: TackManifest;
}

/**
 * Build one {@link TackRuntime} that routes each `invoke` to the source that owns
 * the tool's transport.
 */
export async function createRuntime({ config, manifest, configDir }: CreateRuntimeOptions): Promise<TackRuntime> {
  const preparedConfig = await prepareConfig(config, { configDir });
  const toolsBySource = groupToolsBySource(manifest);

  const runtimeBySource = new Map<Source, TackRuntime>();
  const created = await Promise.allSettled(
    [...toolsBySource].map(async ([source, tools]) =>
      [source, await source.createRuntime({ config: preparedConfig, tools })] as const
    )
  );
  const failure = created.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    const runtimes = created.flatMap((result) => result.status === "fulfilled" ? [result.value[1]] : []);
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    throw failure.reason;
  }
  for (const result of created) {
    if (result.status === "fulfilled") {
      runtimeBySource.set(...result.value);
    }
  }

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
  let closed = false;
  let closePromise: Promise<void> | undefined;

  return {
    invoke: async <TStructured = unknown>(
      toolId: string,
      args: unknown,
      options?: TackRuntimeInvokeOptions
    ): Promise<TackResult<TStructured>> => {
      if (closed) {
        throw new TackRuntimeError({ message: "Tack runtime is closed" });
      }
      const runtime = routes.get(toolId);
      if (!runtime) {
        throw new TackRuntimeError({ message: `Unknown Tack tool: ${toolId}`, toolId });
      }
      return runtime.invoke<TStructured>(toolId, args, options);
    },
    close: async (): Promise<void> => {
      if (closePromise) {
        return closePromise;
      }
      closed = true;
      closePromise = Promise.all(runtimes.map((runtime) => runtime.close())).then(() => undefined);
      return closePromise;
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
