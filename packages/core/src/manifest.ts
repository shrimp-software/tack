import { dedupeName, sanitizeId, toIdentifier } from "./ids.js";
import { ownDataEntries, ownDataValue as ownValue, ownDataValues } from "./own-data.js";
import { manifestConnectionFor, type SourceKind } from "./source-kind.js";
import { BUILTIN_SOURCE_KINDS } from "./source-kinds/index.js";
import type {
  JsonSchema,
  TackConfig,
  TackManifest,
  TackManifestServer,
  TackServerConfig,
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
  const servers = Object.create(null) as Record<string, TackManifestServer>;
  const tools = Object.create(null) as Record<string, TackTool>;
  const configuredServers = ownValue<TackConfig["servers"]>(config, "servers") ?? {};
  const discoveredByServer = new Map(
    discoveredServers.flatMap((server) => {
      const serverId = ownValue<string>(server, "serverId");
      return typeof serverId === "string" ? [[serverId, server] as const] : [];
    })
  );
  const usedNamespaces = new Set<string>(["close", "index", "tack", "types"]);

  for (const [serverId, serverConfig] of ownDataEntries<TackServerConfig>(configuredServers)) {
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

    const discoveredTools = ownDataValues<DiscoveredTool>(ownValue<readonly DiscoveredTool[]>(discovered, "tools"));
    for (const tool of discoveredTools.filter(hasOwnDiscoveredToolName).sort(compareDiscoveredTools)) {
      const toolName = ownValue<string>(tool, "name") ?? "";
      const toolDescription = ownValue<string>(tool, "description");
      const inputSchema = ownValue<JsonSchema>(tool, "inputSchema");
      const outputSchema = ownValue<JsonSchema>(tool, "outputSchema");
      const annotations = ownValue<Record<string, unknown>>(tool, "annotations");
      const baseToolId = sanitizeId(toolName, "tool");
      const toolId = dedupeName(baseToolId, usedToolIds);
      const canonicalId = `${serverId}.${toolId}`;
      const sdkName = dedupeName(
        toIdentifier(toolName, "tool"),
        usedSdkNames
      );

      const manifestTool: TackTool = {
        id: canonicalId,
        serverId,
        namespaceName,
        sdkName,
        upstreamName: toolName,
        ...(toolDescription ? { description: toolDescription } : {}),
        inputSchema: inputSchema ?? { type: "object", additionalProperties: true },
        ...(outputSchema ? { outputSchema } : {}),
        ...(annotations ? { annotations } : {})
      };

      tools[canonicalId] = manifestTool;
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
  const leftName = ownValue<string>(left, "name") ?? "";
  const rightName = ownValue<string>(right, "name") ?? "";
  return sanitizeId(leftName, "tool").localeCompare(sanitizeId(rightName, "tool")) ||
    leftName.localeCompare(rightName);
}

function hasOwnDiscoveredToolName(tool: DiscoveredTool): boolean {
  return typeof ownValue<string>(tool, "name") === "string";
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
