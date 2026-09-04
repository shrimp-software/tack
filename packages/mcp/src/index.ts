import {
  TackRuntimeError,
  buildManifest,
  createTackResult,
  httpSourceKind,
  ownField,
  sanitizeData,
  sanitizeRecord,
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
} from "@cbxss/tack-core";

import {
  closeConnections,
  getConnection,
  normalizeServerConfig,
  openConnection,
  type McpConnection,
  type McpServerConfigEntry
} from "./client.js";

type McpServerEntry = readonly [string, TackServerConfig];

/** The source kinds this package can open an MCP connection to. */
const MCP_SOURCE_KINDS = [stdioSourceKind, httpSourceKind];

/** Whether `value` is a transport this package can open an MCP connection to
 *  (narrows unknown manifest / config data at the boundary). */
function isMcpTransport(value: unknown): value is Transport {
  return MCP_SOURCE_KINDS.some((kind) => kind.transport === value);
}

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
  const clean = sanitizeData(config, {
    onCycle: "Cyclic Tack config data is not supported"
  }) as TackConfig;
  return buildManifest(
    clean,
    await discoverMcpServers(mcpServerEntries(clean)),
    undefined,
    MCP_SOURCE_KINDS
  );
}

function mcpServerEntries(config: TackConfig): McpServerEntry[] {
  return Object.entries(config.servers ?? {}).filter(([, serverConfig]) =>
    isMcpTransport(serverConfig.transport)
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
 *
 * The option bag is snapshotted here at construction — getter-safe reads, and
 * each server config is validated into a stored `McpServerConfigEntry` — so
 * later mutation of the caller's objects cannot change how invoke behaves.
 */
export async function createMcpToolRuntime(
  options: CreateMcpToolRuntimeOptions
): Promise<TackRuntime> {
  const bindingById = new Map<string, McpToolBinding>();
  for (const tool of ownField<readonly unknown[]>(options, "tools") ?? []) {
    const id = ownField<unknown>(tool, "id");
    const serverId = ownField<unknown>(tool, "serverId");
    const upstreamName = ownField<unknown>(tool, "upstreamName");
    if (typeof id === "string" && typeof serverId === "string" && typeof upstreamName === "string") {
      bindingById.set(id, { serverId, upstreamName });
    }
  }

  const servers = ownField<unknown>(ownField(options, "config"), "servers");
  const serverConfigs = snapshotServerConfigs(servers, bindingById);
  const connections = new Map<string, Promise<McpConnection>>();

  return {
    invoke: async <TStructured = unknown>(
      toolId: string,
      args: unknown,
      options: { readonly signal?: AbortSignal | undefined } = {}
    ): Promise<TackResult<TStructured>> => {
      const binding = bindingById.get(toolId);
      if (!binding) {
        throw new TackRuntimeError({ message: `Unknown Tack tool: ${toolId}`, toolId });
      }

      const connection = await getConnection(connections, binding.serverId, serverConfigs);
      try {
        const raw = await connection.client.callTool({
          name: binding.upstreamName,
          arguments: sanitizeRecord(args)
        }, options);
        return createTackResult<TStructured>(raw);
      } catch (cause) {
        throw new TackRuntimeError({
          message: `Failed to call MCP tool ${toolId}: ${errorMessage(cause)}`,
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
  const config = ownField<TackConfig>(options, "config");
  const manifest = sanitizeData(ownField(options, "manifest"), {}) as TackManifest | undefined;

  const { valid, invalid } = partitionManifestTools(manifest);
  const runtime = await createMcpToolRuntime({
    config: (config ?? { servers: {} }) as TackConfig,
    tools: valid
  });
  if (invalid.size === 0) {
    return runtime;
  }

  return {
    invoke: <TStructured = unknown>(toolId: string, args: unknown, options?: { readonly signal?: AbortSignal | undefined }): Promise<TackResult<TStructured>> => {
      const error = invalid.get(toolId);
      return error ? Promise.reject(error) : runtime.invoke<TStructured>(toolId, args, options);
    },
    close: (): Promise<void> => runtime.close()
  };
}

function partitionManifestTools(manifest: TackManifest | undefined): {
  readonly valid: TackTool[];
  readonly invalid: ReadonlyMap<string, TackRuntimeError>;
} {
  const valid: TackTool[] = [];
  const invalid = new Map<string, TackRuntimeError>();
  const servers = manifest?.servers ?? {};

  for (const [toolId, rawTool] of Object.entries(manifest?.tools ?? {})) {
    if (typeof rawTool !== "object" || rawTool === null || Array.isArray(rawTool)) {
      invalid.set(toolId, invalidToolMetadata(toolId));
      continue;
    }

    if (
      rawTool.id !== toolId ||
      typeof rawTool.serverId !== "string" ||
      typeof rawTool.upstreamName !== "string"
    ) {
      invalid.set(toolId, invalidToolMetadata(toolId));
      continue;
    }

    if (isMcpTransport(servers[rawTool.serverId]?.transport)) {
      valid.push(rawTool);
    }
  }

  return { valid, invalid };
}

function snapshotServerConfigs(
  servers: unknown,
  bindings: ReadonlyMap<string, McpToolBinding>
): Map<string, McpServerConfigEntry> {
  const serverConfigs = new Map<string, McpServerConfigEntry>();

  for (const { serverId } of bindings.values()) {
    if (serverConfigs.has(serverId)) {
      continue;
    }

    const serverConfig = ownField<TackServerConfig>(servers, serverId);
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toDiscoveredTool(tool: unknown): DiscoveredTool[] {
  // Wire data from `listTools()` — read getter-safe and build a plain literal.
  // `buildManifest` deep-sanitizes the schemas that pass through here.
  const name = ownField<unknown>(tool, "name");
  if (typeof name !== "string") {
    return [];
  }

  const description = ownField<unknown>(tool, "description");
  const inputSchema = objectRecord(ownField(tool, "inputSchema"));
  const outputSchema = objectRecord(ownField(tool, "outputSchema"));
  const annotations = objectRecord(ownField(tool, "annotations"));
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
