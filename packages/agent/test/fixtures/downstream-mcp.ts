import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export async function startDownstreamMcp(options: { readonly legacy?: boolean } = {}): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    void (options.legacy ? handleLegacyRequest(request, response) : handleStatelessRequest(request, response));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("downstream MCP test server did not bind a port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

async function handleStatelessRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isMcpPost(request, response)) return;
  const message = await readJson(request);
  if (message.method === "tools/list") {
    writeJson(response, 200, { jsonrpc: "2.0", id: message.id, result: { tools: [{
      name: "echo",
      inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] }
    }] } });
    return;
  }
  if (message.method !== "tools/call" || message.params?.name !== "echo") {
    methodNotFound(response, message.id);
    return;
  }
  const mode = message.params.arguments?.message;
  if (mode === "hang") return;
  if (mode === "malformed") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("not json");
    return;
  }
  if (mode === "reset") {
    request.socket.destroy();
    return;
  }
  if (mode === "tool-error") {
    writeJson(response, 200, { jsonrpc: "2.0", id: message.id, result: {
      content: [{ type: "text", text: "expected tool error" }], isError: true
    } });
    return;
  }
  downstreamError(response, message.id);
}

async function handleLegacyRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isMcpPost(request, response)) return;
  const message = await readJson(request);
  if (message.method === "initialize") {
    response.setHeader("mcp-session-id", "legacy-test-session");
    writeJson(response, 200, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: {} } });
    return;
  }
  if (message.method === "notifications/initialized") {
    response.writeHead(202);
    response.end();
    return;
  }
  if (message.method === "tools/list") {
    writeJson(response, 200, { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
    return;
  }
  if (message.method === "tools/call") {
    downstreamError(response, message.id);
    return;
  }
  methodNotFound(response, message.id);
}

function isMcpPost(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method === "POST" && request.url === "/mcp") return true;
  response.writeHead(404);
  response.end();
  return false;
}

function downstreamError(response: ServerResponse, id: string | number | undefined): void {
  writeJson(response, 200, { jsonrpc: "2.0", id, error: { code: -32000, message: "downstream exploded" } });
}

function methodNotFound(response: ServerResponse, id: string | number | undefined): void {
  writeJson(response, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
}

function readJson(request: IncomingMessage): Promise<{
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: { readonly name?: string; readonly arguments?: Record<string, unknown> };
}> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("error", reject);
    request.on("end", () => resolve(JSON.parse(body) as {
      readonly id?: string | number;
      readonly method?: string;
      readonly params?: { readonly name?: string; readonly arguments?: Record<string, unknown> };
    }));
  });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
