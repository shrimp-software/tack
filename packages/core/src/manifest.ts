import { dedupeName, sanitizeId, toIdentifier } from "./ids.js";
import { sanitizeData } from "./sanitize.js";
import { manifestConnectionFor, type SourceKind } from "./source-kind.js";
import { BUILTIN_SOURCE_KINDS } from "./source-kinds/index.js";
import type {
  JsonSchema,
  TackConfig,
  TackManifest,
  TackManifestServer,
  TackTool
} from "./types.js";

export interface DiscoveredTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly annotations?: Record<string, unknown>;
}

export interface DiscoveredServer {
  readonly serverId: string;
  readonly tools: readonly DiscoveredTool[];
}

export function buildManifest(
  config: TackConfig,
  discoveredServers: readonly DiscoveredServer[],
  now = new Date(),
  kinds: readonly SourceKind[] = BUILTIN_SOURCE_KINDS
): TackManifest {
  // The trust boundary: config and discovery results may be hand-built or come
  // straight off an MCP server. Snapshot both to plain own-data once, then read
  // plain typed fields for the rest of the function.
  const cleanConfig = sanitizeData(config, {
    onCycle: "Cyclic Tack config data is not supported"
  }) as TackConfig;
  // A self-referential tool schema from a misbehaving server is odd, not fatal —
  // break the cycle and let the operation planner's own guard handle the rest.
  const cleanDiscovered = sanitizeData(discoveredServers, {}) as readonly DiscoveredServer[];

  const servers = Object.create(null) as Record<string, TackManifestServer>;
  const tools = Object.create(null) as Record<string, TackTool>;
  const discoveredByServer = new Map(
    cleanDiscovered
      .filter((server): server is DiscoveredServer => server != null && typeof server.serverId === "string")
      .map((server) => [server.serverId, server] as const)
  );
  const usedNamespaces = new Set<string>(["close", "index", "tack", "types"]);

  for (const [serverId, serverConfig] of Object.entries(cleanConfig.servers ?? {})) {
    const discovered = discoveredByServer.get(serverId);
    if (!discovered) {
      continue;
    }

    const connection = manifestConnectionFor(kinds, serverConfig);
    if (!connection) {
      continue;
    }

    const usedToolIds = new Set<string>();
    const usedSdkNames = new Set<string>();
    const serverToolIds: string[] = [];
    const namespaceName = dedupeNamespaceName(toIdentifier(serverId, "server"), usedNamespaces);

    const discoveredTools = (discovered.tools ?? [])
      .filter((tool): tool is DiscoveredTool => tool != null && typeof tool.name === "string")
      .sort(compareDiscoveredTools);
    for (const tool of discoveredTools) {
      const toolName = tool.name;
      const toolId = dedupeName(sanitizeId(toolName, "tool"), usedToolIds);
      const canonicalId = `${serverId}.${toolId}`;
      const sdkName = dedupeName(toIdentifier(toolName, "tool"), usedSdkNames);

      tools[canonicalId] = {
        id: canonicalId,
        serverId,
        namespaceName,
        sdkName,
        upstreamName: toolName,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true },
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {})
      };
      serverToolIds.push(canonicalId);
    }

    servers[serverId] = {
      id: serverId,
      ...connection,
      tools: serverToolIds
    };
  }

  return {
    version: "0.1",
    generatedAt: now.toISOString(),
    servers,
    tools
  };
}

function compareDiscoveredTools(left: DiscoveredTool, right: DiscoveredTool): number {
  return (
    sanitizeId(left.name, "tool").localeCompare(sanitizeId(right.name, "tool")) ||
    left.name.localeCompare(right.name)
  );
}

function dedupeNamespaceName(base: string, used: Set<string>): string {
  if (!used.has(base) && !isReservedGeneratedFileName(base)) {
    used.add(base);
    return base;
  }

  let counter = 2;
  while (used.has(`${base}${counter}`) || isReservedGeneratedFileName(`${base}${counter}`)) {
    counter += 1;
  }

  const next = `${base}${counter}`;
  used.add(next);
  return next;
}

function isReservedGeneratedFileName(value: string): boolean {
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(value);
}
