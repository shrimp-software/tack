import {
  ownField,
  sanitizeData,
  sanitizeRecord,
  type TackServerConfig
} from "@tack/core";

import type { McpClient } from "./client.js";

const MCP_PROTOCOL_VERSION = "2025-11-25";

type HttpServerConfig = Extract<TackServerConfig, { readonly transport: "http" }>;

export class StreamableHttpMcpClient implements McpClient {
  private nextId = 1;
  private sessionId: string | undefined;
  private protocolVersion = MCP_PROTOCOL_VERSION;
  private readonly config: HttpServerConfig;

  constructor(config: HttpServerConfig) {
    this.config = normalizeHttpServerConfig(config);
  }

  async connect(): Promise<void> {
    const initialized = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "tack",
        version: "0.1.0"
      }
    }, { includeProtocolVersion: false });

    this.protocolVersion = readProtocolVersion(initialized) ?? this.protocolVersion;
    await this.notification("notifications/initialized", {});
  }

  async listTools(): Promise<{ readonly tools: readonly unknown[] }> {
    const tools: unknown[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      const page = asRecord(result);
      const pageTools = page && Array.isArray(page["tools"]) ? page["tools"] : [];
      tools.push(...pageTools);
      cursor = typeof page?.["nextCursor"] === "string" ? page["nextCursor"] : undefined;
    } while (cursor);

    return { tools };
  }

  callTool(input: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }): Promise<unknown> {
    const name = ownField<unknown>(input, "name");
    if (typeof name !== "string") {
      throw new Error("MCP HTTP tool name is required");
    }

    return this.request("tools/call", {
      name,
      arguments: sanitizeRecord(ownField(input, "arguments"))
    });
  }

  async close(): Promise<void> {
    if (!this.sessionId) {
      return;
    }

    await fetch(this.config.url, {
      method: "DELETE",
      headers: this.headers({ accept: "application/json" })
    }).catch(() => undefined);
  }

  private async notification(method: string, params: Record<string, unknown>): Promise<void> {
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: this.headers({
        accept: "application/json, text/event-stream",
        contentType: "application/json"
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params
      })
    });

    if (!response.ok && response.status !== 202) {
      throw new Error(`MCP HTTP notification ${method} failed with HTTP ${response.status}: ${await response.text()}`);
    }
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    options: { readonly includeProtocolVersion?: boolean } = {}
  ): Promise<unknown> {
    const id = this.nextId++;
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: this.headers({
        accept: "application/json, text/event-stream",
        contentType: "application/json",
        includeProtocolVersion: options.includeProtocolVersion ?? true
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params
      })
    });

    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) {
      this.sessionId = sessionId;
    }

    return readJsonRpcResult(await readJsonRpcResponse(response, id), method);
  }

  private headers(input: {
    readonly accept: string;
    readonly contentType?: string | undefined;
    readonly includeProtocolVersion?: boolean | undefined;
  }): Headers {
    const headers = new Headers(resolveHeaderValues(this.config.headers ?? {}));
    headers.set("accept", input.accept);
    if (input.contentType) {
      headers.set("content-type", input.contentType);
    }
    if (this.sessionId) {
      headers.set("mcp-session-id", this.sessionId);
    }
    if (input.includeProtocolVersion !== false) {
      headers.set("mcp-protocol-version", this.protocolVersion);
    }
    return headers;
  }
}

function normalizeHttpServerConfig(config: HttpServerConfig): HttpServerConfig {
  const clean = sanitizeData(config, {}) as Record<string, unknown>;
  if (typeof clean["url"] !== "string") {
    throw new Error("Invalid HTTP MCP server config: missing url");
  }

  const headers = stringRecord(clean["headers"]);
  return {
    transport: "http",
    url: clean["url"],
    ...(headers ? { headers } : {})
  };
}

async function readJsonRpcResponse(response: Response, id: number): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MCP HTTP request failed with HTTP ${response.status}: ${text}`);
  }

  if (!contentType.includes("text/event-stream")) {
    const message = text.length > 0 ? JSON.parse(text) as unknown : {};
    assertJsonRpcResponseId(message, id);
    return message;
  }

  const match = parseSseJsonMessages(text).find((message) => asRecord(message)?.["id"] === id);
  if (!match) {
    throw new Error(`MCP HTTP SSE response did not include response id ${id}`);
  }
  return match;
}

function assertJsonRpcResponseId(message: unknown, id: number): void {
  if (asRecord(message)?.["id"] !== id) {
    throw new Error(`MCP HTTP response did not include response id ${id}`);
  }
}

function readJsonRpcResult(message: unknown, method: string): unknown {
  const record = asRecord(message);
  const error = asRecord(record?.["error"]);
  if (error) {
    throw new Error(`MCP HTTP ${method} failed: ${String(error["message"] ?? "unknown error")}`);
  }
  if (!record || !Object.hasOwn(record, "result")) {
    throw new Error(`MCP HTTP ${method} returned no result`);
  }
  return record["result"];
}

function parseSseJsonMessages(text: string): unknown[] {
  const messages: unknown[] = [];
  let dataLines: string[] = [];

  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) {
      if (dataLines.length > 0) {
        messages.push(JSON.parse(dataLines.join("\n")) as unknown);
        dataLines = [];
      }
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length > 0) {
    messages.push(JSON.parse(dataLines.join("\n")) as unknown);
  }

  return messages;
}

function readProtocolVersion(result: unknown): string | undefined {
  const protocolVersion = asRecord(result)?.["protocolVersion"];
  return typeof protocolVersion === "string" ? protocolVersion : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function resolveHeaderValues(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, interpolateEnv(value)])
  );
}

/** Keep only string-valued entries of an already-sanitized record. */
function stringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const normalized = Object.create(null) as Record<string, string>;
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string") {
      normalized[key] = entryValue;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, name: string) =>
    process.env[name] ?? ""
  );
}
