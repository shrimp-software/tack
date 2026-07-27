import {
  TackRuntimeError,
  buildManifest,
  createTackResult,
  ownDataEntries,
  ownDataRecord,
  ownDataValue as ownValue,
  type DiscoveredServer,
  type DiscoveredTool,
  type TackConfig,
  type TackManifest,
  type TackResult,
  type TackRuntime
} from "@tack/core";

import {
  closeConnections,
  getConnection,
  normalizeServerConfig,
  openConnection,
  type McpConnection,
  type McpServerConfigEntry
} from "./client.js";

export async function discoverMcpManifestPromise(config: TackConfig): Promise<TackManifest> {
  const servers = ownValue<TackConfig["servers"]>(config, "servers");
  const discovered = await Promise.all(
    ownDataEntries<TackConfig["servers"][string]>(servers).map(([serverId, serverConfig]) =>
      discoverServer(serverId, serverConfig)
    )
  );
  return buildManifest(config, discovered);
}

export interface CreateMcpRuntimeOptions {
  readonly config: TackConfig;
  readonly manifest: TackManifest;
}

interface RuntimeToolMetadata {
  readonly serverId: string;
  readonly upstreamName: string;
}

type RuntimeToolMetadataEntry =
  | { readonly ok: true; readonly metadata: RuntimeToolMetadata }
  | { readonly ok: false; readonly error: TackRuntimeError };

export async function createMcpRuntime(
  options: CreateMcpRuntimeOptions
): Promise<TackRuntime> {
  const config = ownValue<TackConfig>(options, "config") as TackConfig;
  const manifest = ownValue<TackManifest>(options, "manifest") as TackManifest;
  const toolMetadataById = snapshotToolMetadata(manifest);
  const serverConfigs = snapshotServerConfigs(config, toolMetadataById);
  const connections = new Map<string, Promise<McpConnection>>();

  return {
    invoke: async <TStructured = unknown>(
      toolId: string,
      args: unknown
    ): Promise<TackResult<TStructured>> => {
      const tool = toolMetadata(toolMetadataById, toolId);
      if (!tool) {
        throw new TackRuntimeError({ message: `Unknown Tack tool: ${toolId}`, toolId });
      }

      const connection = await getConnection(connections, tool.serverId, serverConfigs);

      try {
        const raw = await connection.client.callTool({
          name: tool.upstreamName,
          arguments: ownDataRecord(args)
        });
        return createTackResult<TStructured>(raw);
      } catch (cause) {
        throw new TackRuntimeError({
          message: `Failed to call MCP tool ${toolId}`,
          toolId,
          serverId: tool.serverId,
          cause
        });
      }
    },
    close: async (): Promise<void> => closeConnections(connections)
  };
}

function toolMetadata(
  metadata: ReadonlyMap<string, RuntimeToolMetadataEntry>,
  toolId: string
): RuntimeToolMetadata | undefined {
  const entry = metadata.get(toolId);
  if (!entry) {
    return undefined;
  }

  if (!entry.ok) {
    throw entry.error;
  }

  return entry.metadata;
}

function snapshotToolMetadata(manifest: TackManifest): Map<string, RuntimeToolMetadataEntry> {
  const metadata = new Map<string, RuntimeToolMetadataEntry>();
  const tools = ownValue<TackManifest["tools"]>(manifest, "tools");
  for (const [toolId, tool] of ownDataEntries<unknown>(tools)) {
    metadata.set(toolId, normalizeToolMetadata(toolId, tool));
  }
  return metadata;
}

function normalizeToolMetadata(toolId: string, tool: unknown): RuntimeToolMetadataEntry {
  if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
    return { ok: false, error: invalidToolMetadata(toolId) };
  }

  const id = ownValue<unknown>(tool, "id");
  const serverId = ownValue<unknown>(tool, "serverId");
  const upstreamName = ownValue<unknown>(tool, "upstreamName");
  if (id !== toolId || typeof serverId !== "string" || typeof upstreamName !== "string") {
    return { ok: false, error: invalidToolMetadata(toolId) };
  }

  return { ok: true, metadata: { serverId, upstreamName } };
}

function snapshotServerConfigs(
  config: TackConfig,
  metadata: ReadonlyMap<string, RuntimeToolMetadataEntry>
): Map<string, McpServerConfigEntry> {
  const serverConfigs = new Map<string, McpServerConfigEntry>();
  const servers = ownValue<TackConfig["servers"]>(config, "servers");
  for (const entry of metadata.values()) {
    if (!entry.ok || serverConfigs.has(entry.metadata.serverId)) {
      continue;
    }

    const serverConfig = ownValue<TackConfig["servers"][string]>(servers, entry.metadata.serverId);
    if (!serverConfig) {
      continue;
    }

    try {
      serverConfigs.set(entry.metadata.serverId, {
        ok: true,
        config: normalizeServerConfig(serverConfig)
      });
    } catch (error) {
      serverConfigs.set(entry.metadata.serverId, {
        ok: false,
        error: error instanceof TackRuntimeError
          ? error
          : new TackRuntimeError({
              message: `Invalid MCP server config for ${entry.metadata.serverId}`,
              serverId: entry.metadata.serverId,
              cause: error
            })
      });
    }
  }
  return serverConfigs;
}

function invalidToolMetadata(toolId: string): TackRuntimeError {
  return new TackRuntimeError({
    message: `Invalid Tack tool metadata for ${toolId}`,
    toolId
  });
}

async function discoverServer(
  serverId: string,
  serverConfig: TackConfig["servers"][string]
): Promise<DiscoveredServer> {
  try {
    const connection = await openConnection(serverConfig);

    try {
      const { tools } = await connection.client.listTools();
      return { serverId, tools: tools.flatMap(toDiscoveredTool) };
    } finally {
      await connection.client.close();
    }
  } catch (cause) {
    throw new TackRuntimeError({
      message: `Failed to discover MCP server ${serverId}`,
      serverId,
      cause
    });
  }
}

function toDiscoveredTool(tool: unknown): DiscoveredTool[] {
  const source = objectRecord(tool);
  const name = ownValue<unknown>(source, "name");
  if (typeof name !== "string") {
    return [];
  }

  const description = ownValue<unknown>(source, "description");
  const inputSchema = objectRecord(ownValue<unknown>(source, "inputSchema"));
  const outputSchema = objectRecord(ownValue<unknown>(source, "outputSchema"));
  const annotations = objectRecord(ownValue<unknown>(source, "annotations"));
  return [{
    name,
    ...(typeof description === "string" ? { description } : {}),
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    ...(annotations ? { annotations } : {})
  }];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
