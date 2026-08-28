import { dedupeName, sanitizeId, toIdentifier } from "./ids.js";
import { ownDataEntries, ownDataValue as ownValue, ownDataValues } from "./own-data.js";
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

type ManifestServerConnection = Omit<TackManifestServer, "id" | "tools">;

export function buildManifest(
  config: TackConfig,
  discoveredServers: readonly DiscoveredServer[],
  now = new Date()
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

    const connection = manifestServerConnection(serverConfig);
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

function manifestServerConnection(
  serverConfig: TackServerConfig
): ManifestServerConnection | undefined {
  const transport = ownValue<TackServerConfig["transport"]>(serverConfig, "transport");
  if (transport === "stdio") {
    const command = ownValue<string>(serverConfig, "command");
    if (typeof command !== "string") {
      return undefined;
    }

    const args = ownStringArray(serverConfig, "args");
    const env = ownStringRecord(serverConfig, "env");
    const inheritEnv = ownValue<boolean>(serverConfig, "inheritEnv");
    const cwd = ownValue<string>(serverConfig, "cwd");
    return {
      transport: "stdio",
      command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(inheritEnv === true ? { inheritEnv: true } : {}),
      ...(cwd ? { cwd } : {})
    };
  }

  if (transport === "http") {
    const url = ownValue<string>(serverConfig, "url");
    if (typeof url !== "string") {
      return undefined;
    }

    const headers = ownStringRecord(serverConfig, "headers");
    return {
      transport: "http",
      url,
      ...(headers ? { headers } : {})
    };
  }

  if (transport === "module") {
    const entry = ownValue<string>(serverConfig, "entry");
    if (typeof entry !== "string") {
      return undefined;
    }

    return {
      transport: "module",
      entry
    };
  }

  return undefined;
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

function ownStringArray(object: object | undefined, key: string): readonly string[] | undefined {
  const value = ownValue<unknown>(object, key);
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = ownDataValues<unknown>(value).filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : undefined;
}

function ownStringRecord(object: object | undefined, key: string): Readonly<Record<string, string>> | undefined {
  const value = ownValue<unknown>(object, key);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = Object.create(null) as Record<string, string>;
  for (const [entryKey, entryValue] of ownDataEntries<unknown>(value)) {
    if (typeof entryValue === "string") {
      record[entryKey] = entryValue;
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
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
