import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  TackRuntimeError,
  ownField,
  sanitizeRecord,
  type HttpServerConfig,
  type StdioServerConfig,
  type TackConfig
} from "@cbxss/tack-core";

import { StreamableHttpMcpClient } from "./http-client.js";

/** The MCP-backed subset of server configs this module can connect to. */
type McpServerConfig = StdioServerConfig | HttpServerConfig;

export interface McpClient {
  listTools(): Promise<{ readonly tools: readonly unknown[] }>;
  callTool(input: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }, options?: { readonly signal?: AbortSignal | undefined }): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpConnection {
  readonly transport: "http" | "stdio";
  readonly client: McpClient;
}

export interface McpConnectionLease {
  readonly connection: McpConnection;
  readonly generation: symbol;
}

export type McpServerConfigEntry =
  | { readonly ok: true; readonly config: McpServerConfig }
  | { readonly ok: false; readonly error: TackRuntimeError };

interface ConnectionSlot {
  readonly generation: symbol;
  readonly promise: Promise<McpConnection>;
  closePromise?: Promise<void> | undefined;
}

/** Owns lazy connections and atomically retires a cancelled stdio generation. */
export class McpConnectionPool {
  private readonly slots = new Map<string, ConnectionSlot>();
  private readonly slotsByGeneration = new Map<symbol, ConnectionSlot>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  async acquire(
    serverId: string,
    serverConfigs: ReadonlyMap<string, McpServerConfigEntry>
  ): Promise<McpConnectionLease> {
    this.throwIfClosed();
    const slot = this.slots.get(serverId) ?? this.open(serverId, serverConfigs);
    const connection = await slot.promise;
    if (this.closed) {
      await this.closeSlot(slot).catch(() => undefined);
      this.throwIfClosed();
    }
    return { connection, generation: slot.generation };
  }

  /** Stdio has no request-level cancellation, so retire before closing it. */
  async invalidate(serverId: string, lease: McpConnectionLease): Promise<void> {
    const slot = this.slotsByGeneration.get(lease.generation);
    if (!slot) {
      return;
    }
    if (this.slots.get(serverId) === slot) {
      this.slots.delete(serverId);
    }
    await this.retire(slot);
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    const slots = [...this.slotsByGeneration.values()];
    this.slots.clear();
    this.closePromise = Promise.all(slots.map((slot) => this.retire(slot))).then(() => undefined);
    return this.closePromise;
  }

  private open(
    serverId: string,
    serverConfigs: ReadonlyMap<string, McpServerConfigEntry>
  ): ConnectionSlot {
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

    const generation = Symbol(serverId);
    let slot: ConnectionSlot;
    const promise = openConnection(serverConfig.config).catch((cause) => {
      if (this.slots.get(serverId) === slot) {
        this.slots.delete(serverId);
      }
      this.slotsByGeneration.delete(generation);
      throw new TackRuntimeError({
        message: `Failed to connect to MCP server ${serverId}`,
        serverId,
        cause
      });
    });
    slot = { generation, promise };
    this.slots.set(serverId, slot);
    this.slotsByGeneration.set(generation, slot);
    return slot;
  }

  private async retire(slot: ConnectionSlot): Promise<void> {
    try {
      await this.closeSlot(slot);
    } finally {
      this.slotsByGeneration.delete(slot.generation);
    }
  }

  private closeSlot(slot: ConnectionSlot): Promise<void> {
    slot.closePromise ??= slot.promise.then((connection) => connection.client.close());
    return slot.closePromise;
  }

  private throwIfClosed(): void {
    if (this.closed) {
      throw new TackRuntimeError({ message: "MCP runtime is closed" });
    }
  }
}

export async function openConnection(serverConfig: TackConfig["servers"][string]): Promise<McpConnection> {
  const normalized = normalizeServerConfig(serverConfig);

  if (normalized.transport === "http") {
    const client = new StreamableHttpMcpClient(normalized);
    await client.connect();
    return { transport: "http", client };
  }

  return openStdioConnection(normalized);
}

/**
 * Validate an untrusted server config into the MCP-connectable subset. This is
 * the lazy per-server boundary: reads are getter-safe and a malformed field
 * throws a specific `TackRuntimeError` that the caller defers to invoke time.
 */
export function normalizeServerConfig(serverConfig: TackConfig["servers"][string]): McpServerConfig {
  const transport = ownField<unknown>(serverConfig, "transport");
  if (transport === "http") {
    const url = ownField<unknown>(serverConfig, "url");
    if (typeof url !== "string") {
      throw new TackRuntimeError({ message: "Invalid HTTP MCP server config: missing url" });
    }

    const headers = optionalStringRecord(ownField(serverConfig, "headers"), "headers");
    return {
      transport,
      url,
      ...(headers ? { headers } : {})
    };
  }

  if (transport === "stdio") {
    const command = ownField<unknown>(serverConfig, "command");
    if (typeof command !== "string") {
      throw new TackRuntimeError({ message: "Invalid stdio MCP server config: missing command" });
    }

    const args = optionalStringArray(ownField(serverConfig, "args"), "args");
    const env = optionalStringRecord(ownField(serverConfig, "env"), "env");
    const inheritEnv = optionalBoolean(ownField(serverConfig, "inheritEnv"), "inheritEnv");
    const cwd = optionalString(ownField(serverConfig, "cwd"), "cwd");
    return {
      transport,
      command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(inheritEnv !== undefined ? { inheritEnv } : {}),
      ...(cwd ? { cwd } : {})
    };
  }

  throw new TackRuntimeError({
    message: `Not an MCP transport: ${typeof transport === "string" ? transport : "missing"}`
  });
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
    transport: "stdio",
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

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TackRuntimeError({ message: `Invalid MCP server config: ${label} must be a string` });
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new TackRuntimeError({ message: `Invalid MCP server config: ${label} must be a boolean` });
  }
  return value;
}

function optionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new TackRuntimeError({ message: `Invalid MCP server config: ${label} must be a string array` });
  }

  const normalized: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new TackRuntimeError({ message: `Invalid MCP server config: ${label} must be a string array` });
    }
    normalized.push(descriptor.value);
  }
  return normalized;
}

function optionalStringRecord(
  value: unknown,
  label: string
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TackRuntimeError({ message: `Invalid MCP server config: ${label} must be a string record` });
  }

  const normalized = Object.create(null) as Record<string, string>;
  for (const [entryKey, entryValue] of Object.entries(sanitizeRecord(value))) {
    if (typeof entryValue !== "string") {
      throw new TackRuntimeError({ message: `Invalid MCP server config: ${label} must be a string record` });
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
