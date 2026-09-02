import {
  ownField,
  sanitizeData,
  sanitizeRecord,
  type TackServerConfig
} from "@cbxss/tack-core";

import type { McpClient } from "./client.js";

const MCP_PROTOCOL_VERSION = "2026-07-28";
const CLIENT_INFO = { name: "tack", version: "1.0.1" } as const;

type HttpServerConfig = Extract<TackServerConfig, { readonly transport: "http" }>;

export class StreamableHttpMcpClient implements McpClient {
  private nextId = 1;
  private readonly config: HttpServerConfig;

  constructor(config: HttpServerConfig) {
    this.config = normalizeHttpServerConfig(config);
  }

  /** Stateless MCP has no transport handshake. */
  async connect(): Promise<void> {}

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
    }, { toolName: name });
  }

  async close(): Promise<void> {}

  private async request(
    method: string,
    params: Record<string, unknown>,
    options: { readonly toolName?: string | undefined } = {}
  ): Promise<unknown> {
    const id = this.nextId++;
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: this.headers({
        accept: "application/json, text/event-stream",
        contentType: "application/json",
        method,
        ...(options.toolName ? { toolName: options.toolName } : {})
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": CLIENT_INFO
          }
        }
      })
    });

    return readJsonRpcResult(await readJsonRpcResponse(response, id), method);
  }

  private headers(input: {
    readonly accept: string;
    readonly contentType?: string | undefined;
    readonly method: string;
    readonly toolName?: string | undefined;
  }): Headers {
    const headers = new Headers(resolveHeaderValues(this.config.headers ?? {}));
    headers.set("accept", input.accept);
    if (input.contentType) {
      headers.set("content-type", input.contentType);
    }
    headers.set("mcp-protocol-version", MCP_PROTOCOL_VERSION);
    headers.set("mcp-method", input.method);
    if (input.toolName) headers.set("mcp-name", input.toolName);
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
