import {
  TackRuntimeError,
  buildManifest,
  createTackResult,
  httpSourceKind,
  ownDataEntries,
  ownDataRecord,
  ownDataValue as ownValue,
  stdioSourceKind,
  type DiscoveredServer,
  type DiscoveredTool,
  type TackConfig,
  type TackManifest,
  type TackResult,
  type TackRuntime,
  type TackServerConfig,
  type TackTool,
  type Transport
} from "@tack/core";

/** The source kinds this package can open an MCP connection to. */
const MCP_SOURCE_KINDS = [stdioSourceKind, httpSourceKind];
const MCP_TRANSPORTS = new Set<Transport>(MCP_SOURCE_KINDS.map((kind) => kind.transport));

/** Whether `value` is a transport `@tack/mcp` can connect to (narrows unknown
 *  manifest/config data at the boundary). */
function isMcpTransport(value: unknown): value is Transport {
  return typeof value === "string" && (MCP_TRANSPORTS as ReadonlySet<string>).has(value);
}

import {
  closeConnections,
  getConnection,
  normalizeServerConfig,
  openConnection,
  type McpConnection,
  type McpServerConfigEntry
} from "./client.js";

type McpServerEntry = readonly [string, TackServerConfig];

/**
 * Discover the given MCP server configs. Entries are expected to be pre-filtered
 * to the `stdio` / `http` transports by the caller.
 */
export async function discoverMcpServers(
  entries: readonly McpServerEntry[]
): Promise<DiscoveredServer[]> {
  return Promise.all(entries.map(([serverId, serverConfig]) => discoverServer(serverId, serverConfig)));
}

export async function discoverMcpManifestPromise(config: TackConfig): Promise<TackManifest> {
  return buildManifest(
    config,
    await discoverMcpServers(mcpServerEntries(config)),
    undefined,
    MCP_SOURCE_KINDS
  );
}

function mcpServerEntries(config: TackConfig): McpServerEntry[] {
  return ownDataEntries<TackServerConfig>(ownValue<TackConfig["servers"]>(config, "servers")).filter(
    ([, serverConfig]) => MCP_TRANSPORTS.has(serverConfig.transport)
  );
}

export interface CreateMcpToolRuntimeOptions {
  readonly config: TackConfig;
  readonly tools: readonly TackTool[];
}

interface McpToolBinding {
  readonly serverId: string;
  readonly upstreamName: string;
}

/**
 * A `TackRuntime` for a known-good set of MCP tools. Callers pass exactly the
 * tools this runtime owns; server connection details come from `config`.
 */
export async function createMcpToolRuntime(
  options: CreateMcpToolRuntimeOptions
): Promise<TackRuntime> {
  const config = ownValue<TackConfig>(options, "config") as TackConfig;
  const tools = ownValue<readonly TackTool[]>(options, "tools") as readonly TackTool[];

  const bindingById = new Map<string, McpToolBinding>();
  for (const tool of tools) {
    bindingById.set(tool.id, { serverId: tool.serverId, upstreamName: tool.upstreamName });
  }
  const serverConfigs = snapshotServerConfigs(config, bindingById);
  const connections = new Map<string, Promise<McpConnection>>();

  return {
    invoke: async <TStructured = unknown>(
      toolId: string,
      args: unknown
    ): Promise<TackResult<TStructured>> => {
      const binding = bindingById.get(toolId);
      if (!binding) {
        throw new TackRuntimeError({ message: `Unknown Tack tool: ${toolId}`, toolId });
      }

      const connection = await getConnection(connections, binding.serverId, serverConfigs);

      try {
        const raw = await connection.client.callTool({
          name: binding.upstreamName,
          arguments: ownDataRecord(args)
        });
        return createTackResult<TStructured>(raw);
      } catch (cause) {
        throw new TackRuntimeError({
          message: `Failed to call MCP tool ${toolId}`,
          toolId,
          serverId: binding.serverId,
          cause
        });
      }
    },
    close: async (): Promise<void> => closeConnections(connections)
  };
}

export interface CreateMcpRuntimeOptions {
  readonly config: TackConfig;
  readonly manifest: TackManifest;
}

/**
 * Build a runtime for every MCP-backed tool in a manifest. Tolerates a manifest
 * whose tool metadata is malformed: such tools reject on invoke rather than
 * failing construction.
 */
export async function createMcpRuntime(options: CreateMcpRuntimeOptions): Promise<TackRuntime> {
  const config = ownValue<TackConfig>(options, "config") as TackConfig;
  const manifest = ownValue<TackManifest>(options, "manifest") as TackManifest;

  const { valid, invalid } = partitionManifestTools(manifest);
  const runtime = await createMcpToolRuntime({ config, tools: valid });
  if (invalid.size === 0) {
    return runtime;
  }

  return {
    invoke: <TStructured = unknown>(toolId: string, args: unknown): Promise<TackResult<TStructured>> => {
      const error = invalid.get(toolId);
      return error ? Promise.reject(error) : runtime.invoke<TStructured>(toolId, args);
    },
    close: (): Promise<void> => runtime.close()
  };
}

function partitionManifestTools(manifest: TackManifest): {
  readonly valid: TackTool[];
  readonly invalid: ReadonlyMap<string, TackRuntimeError>;
} {
  const valid: TackTool[] = [];
  const invalid = new Map<string, TackRuntimeError>();
  const servers = ownValue<TackManifest["servers"]>(manifest, "servers");

  for (const [toolId, rawTool] of ownDataEntries<unknown>(ownValue<TackManifest["tools"]>(manifest, "tools"))) {
    if (typeof rawTool !== "object" || rawTool === null || Array.isArray(rawTool)) {
      invalid.set(toolId, invalidToolMetadata(toolId));
      continue;
    }

    const id = ownValue<unknown>(rawTool, "id");
    const serverId = ownValue<unknown>(rawTool, "serverId");
    const upstreamName = ownValue<unknown>(rawTool, "upstreamName");
    if (id !== toolId || typeof serverId !== "string" || typeof upstreamName !== "string") {
      invalid.set(toolId, invalidToolMetadata(toolId));
      continue;
    }

    const server = ownValue<TackManifest["servers"][string]>(servers, serverId);
    if (isMcpTransport(ownValue<unknown>(server, "transport"))) {
      valid.push(rawTool as TackTool);
    }
  }

  return { valid, invalid };
}

function snapshotServerConfigs(
  config: TackConfig,
  bindings: ReadonlyMap<string, McpToolBinding>
): Map<string, McpServerConfigEntry> {
  const serverConfigs = new Map<string, McpServerConfigEntry>();
  const servers = ownValue<TackConfig["servers"]>(config, "servers");

  for (const { serverId } of bindings.values()) {
    if (serverConfigs.has(serverId)) {
      continue;
    }

    const serverConfig = ownValue<TackConfig["servers"][string]>(servers, serverId);
    if (!serverConfig) {
      continue;
    }

    try {
      serverConfigs.set(serverId, { ok: true, config: normalizeServerConfig(serverConfig) });
    } catch (error) {
      serverConfigs.set(serverId, {
        ok: false,
        error:
          error instanceof TackRuntimeError
            ? error
            : new TackRuntimeError({
                message: `Invalid MCP server config for ${serverId}`,
                serverId,
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
  serverConfig: TackServerConfig
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
