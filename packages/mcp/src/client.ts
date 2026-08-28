import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  TackRuntimeError,
  ownDataEntries,
  ownDataValue as ownValue,
  type HttpServerConfig,
  type StdioServerConfig,
  type TackConfig
} from "@tack/core";

import { StreamableHttpMcpClient } from "./http-client.js";

/** The MCP-backed subset of server configs this module can connect to. */
type McpServerConfig = StdioServerConfig | HttpServerConfig;

export interface McpClient {
  listTools(): Promise<{ readonly tools: readonly unknown[] }>;
  callTool(input: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpConnection {
  readonly client: McpClient;
}

export type McpServerConfigEntry =
  | { readonly ok: true; readonly config: McpServerConfig }
  | { readonly ok: false; readonly error: TackRuntimeError };

export async function getConnection(
  connections: Map<string, Promise<McpConnection>>,
  serverId: string,
  serverConfigs: ReadonlyMap<string, McpServerConfigEntry>
): Promise<McpConnection> {
  const existing = connections.get(serverId);
  if (existing) {
    return existing;
  }

  const serverConfig = serverConfigs.get(serverId);
  if (!serverConfig) {
    throw new TackRuntimeError({
      message: `No config found for server ${serverId}`,
      serverId
    });
  }
  if (!serverConfig.ok) {
    throw serverConfig.error;
  }

  const pending = openConnection(serverConfig.config).catch((error) => {
    if (connections.get(serverId) === pending) {
      connections.delete(serverId);
    }
    throw error;
  });
  connections.set(serverId, pending);
  return pending;
}

export async function closeConnections(
  connections: Map<string, Promise<McpConnection>>
): Promise<void> {
  const settled = await Promise.allSettled(connections.values());
  connections.clear();

  await Promise.all(
    settled.map(async (entry) => {
      if (entry.status === "fulfilled") {
        await entry.value.client.close();
      }
    })
  );
}

export async function openConnection(serverConfig: TackConfig["servers"][string]): Promise<McpConnection> {
  const normalized = normalizeServerConfig(serverConfig);

  if (normalized.transport === "http") {
    const client = new StreamableHttpMcpClient(normalized);
    await client.connect();
    return { client };
  }

  return openStdioConnection(normalized);
}

export function normalizeServerConfig(serverConfig: TackConfig["servers"][string]): McpServerConfig {
  const transport = ownValue<unknown>(serverConfig, "transport");
  if (transport === "http") {
    const url = ownValue<unknown>(serverConfig, "url");
    if (typeof url !== "string") {
      throw new TackRuntimeError({ message: "Invalid HTTP MCP server config: missing url" });
    }

    const headers = optionalStringRecord(serverConfig, "headers");
    return {
      transport,
      url,
      ...(headers ? { headers } : {})
    };
  }

  if (transport === "stdio") {
    const command = ownValue<unknown>(serverConfig, "command");
    if (typeof command !== "string") {
      throw new TackRuntimeError({ message: "Invalid stdio MCP server config: missing command" });
    }

    const args = optionalStringArray(serverConfig, "args");
    const env = optionalStringRecord(serverConfig, "env");
    const inheritEnv = optionalBoolean(serverConfig, "inheritEnv");
    const cwd = optionalString(serverConfig, "cwd");
    return {
      transport,
      command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(inheritEnv !== undefined ? { inheritEnv } : {}),
      ...(cwd ? { cwd } : {})
    };
  }

  if (transport === "module") {
    throw new TackRuntimeError({
      message: "Module sources have no MCP connection; they run through the module runtime"
    });
  }

  throw new TackRuntimeError({ message: "Invalid MCP server config: missing transport" });
}

async function openStdioConnection(
  serverConfig: StdioServerConfig
): Promise<McpConnection> {
  const client = new Client({ name: "tack", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: [...(serverConfig.args ?? [])],
    env: scopedProcessEnv(serverConfig),
    ...(serverConfig.cwd ? { cwd: serverConfig.cwd } : {}),
    stderr: "pipe"
  });

  await client.connect(transport);
  return {
    client: {
      listTools: () => client.listTools(),
      callTool: (input) => client.callTool(input),
      close: async () => {
        await Promise.allSettled([
          client.close(),
          transport.close()
        ]);
      }
    }
  };
}

function scopedProcessEnv(
  serverConfig: StdioServerConfig
): Record<string, string> {
  return {
    ...(serverConfig.inheritEnv === true ? processEnv() : minimalProcessEnv()),
    ...(serverConfig.env ?? {})
  };
}

function optionalString(
  object: object,
  key: string
): string | undefined {
  const value = ownValue<unknown>(object, key);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TackRuntimeError({ message: `Invalid MCP server config: ${key} must be a string` });
  }
  return value;
}

function optionalBoolean(
  object: object,
  key: string
): boolean | undefined {
  const value = ownValue<unknown>(object, key);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new TackRuntimeError({ message: `Invalid MCP server config: ${key} must be a boolean` });
  }
  return value;
}

function optionalStringArray(
  object: object,
  key: string
): readonly string[] | undefined {
  const value = ownValue<unknown>(object, key);
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new TackRuntimeError({ message: `Invalid MCP server config: ${key} must be a string array` });
  }

  const normalized: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new TackRuntimeError({ message: `Invalid MCP server config: ${key} must be a string array` });
    }
    normalized.push(descriptor.value);
  }
  return normalized;
}

function optionalStringRecord(
  object: object,
  key: string
): Readonly<Record<string, string>> | undefined {
  const value = ownValue<unknown>(object, key);
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TackRuntimeError({ message: `Invalid MCP server config: ${key} must be a string record` });
  }

  const normalized = Object.create(null) as Record<string, string>;
  for (const [entryKey, entryValue] of ownDataEntries<unknown>(value)) {
    if (typeof entryValue !== "string") {
      throw new TackRuntimeError({ message: `Invalid MCP server config: ${key} must be a string record` });
    }
    normalized[entryKey] = entryValue;
  }
  return normalized;
}

function processEnv(): Record<string, string> {
  return definedEnv(process.env);
}

function minimalProcessEnv(): Record<string, string> {
  return definedEnv({
    PATH: process.env["PATH"],
    Path: process.env["Path"],
    PATHEXT: process.env["PATHEXT"],
    SystemRoot: process.env["SystemRoot"],
    windir: process.env["windir"]
  });
}

function definedEnv(
  env: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}
