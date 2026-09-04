import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import type { TackConfig } from "@cbxss/tack-core";
import { createQuickJSRuntime } from "@cbxss/tack-runtime-quickjs";
import { createRuntime, discoverManifest } from "@cbxss/tack-sources";

import { createTackAgentServer } from "../src/index.js";

/**
 * Regression coverage for the complete error path:
 *
 * downstream HTTP MCP -> MCP runtime -> code-mode execute -> parent MCP execute.
 *
 * This is deliberately an in-process HTTP server rather than a Testcontainer. The
 * boundary we need to protect is the MCP JSON-RPC request/response boundary; a
 * container would add startup cost without exercising a different path.
 */
describe("downstream MCP errors over execute (e2e)", () => {
  it("surfaces a downstream JSON-RPC error before the execution timeout", async () => {
    const agent = await connectAgent();

    try {
      const executed = await agent.client.callTool({
        name: "execute",
        arguments: { code: 'return await tools.downstream.echo({ message: "fail" });' }
      });

      expect(executed.isError).toBe(true);
      expect(executed.structuredContent).toMatchObject({
        status: "error",
        error: {
          phase: "runtime",
          code: "downstream_error",
          message: expect.stringContaining("downstream exploded")
        }
      });
    } finally {
      await agent.close();
    }
  });

  it("keeps a valid downstream isError in the tool result", async () => {
    const agent = await connectAgent();
    try {
      const executed = await agent.client.callTool({
        name: "execute",
        arguments: { code: 'return await tools.downstream.echo({ message: "tool-error" });' }
      });

      expect(executed.isError).toBeUndefined();
      expect(executed.structuredContent).toMatchObject({
        status: "completed",
        result: { ok: false, error: { code: "tool_error", message: "expected tool error" } }
      });
    } finally {
      await agent.close();
    }
  });

  it("aborts a hung downstream request and reports tool_timeout", async () => {
    const agent = await connectAgent({ toolTimeoutMs: 50 });
    const started = Date.now();
    try {
      const executed = await agent.client.callTool({
        name: "execute",
        arguments: { code: 'return await tools.downstream.echo({ message: "hang" });' }
      });

      expect(Date.now() - started).toBeLessThan(750);
      expect(executed.isError).toBe(true);
      expect(executed.structuredContent).toMatchObject({
        status: "error",
        error: { phase: "runtime", code: "tool_timeout" }
      });
    } finally {
      await agent.close();
    }
  });

  it("maps malformed downstream responses to downstream_error", async () => {
    const agent = await connectAgent();
    try {
      const executed = await agent.client.callTool({
        name: "execute",
        arguments: { code: 'return await tools.downstream.echo({ message: "malformed" });' }
      });

      expect(executed.isError).toBe(true);
      expect(executed.structuredContent).toMatchObject({
        status: "error",
        error: { phase: "runtime", code: "downstream_error" }
      });
    } finally {
      await agent.close();
    }
  });

  it("maps a downstream connection reset to downstream_error", async () => {
    const agent = await connectAgent();
    try {
      const executed = await agent.client.callTool({
        name: "execute",
        arguments: { code: 'return await tools.downstream.echo({ message: "reset" });' }
      });

      expect(executed.isError).toBe(true);
      expect(executed.structuredContent).toMatchObject({
        status: "error",
        error: { phase: "runtime", code: "downstream_error" }
      });
    } finally {
      await agent.close();
    }
  });

  it("preserves failures from legacy stateful HTTP MCP servers", async () => {
    const agent = await connectAgent({ legacy: true });
    try {
      const executed = await agent.client.callTool({
        name: "execute",
        arguments: { code: 'return await tools.downstream.echo({ message: "fail" });' }
      });

      expect(executed.isError).toBe(true);
      expect(executed.structuredContent).toMatchObject({
        status: "error",
        error: { phase: "runtime", code: "downstream_error", message: expect.stringContaining("downstream exploded") }
      });
    } finally {
      await agent.close();
    }
  });
});

async function connectAgent(options: { readonly toolTimeoutMs?: number; readonly legacy?: boolean } = {}): Promise<{
  readonly client: Client;
  readonly close: () => Promise<void>;
}> {
  const downstream = await startFailingDownstreamMcp(options.legacy);
  const config: TackConfig = { servers: { downstream: { transport: "http", url: downstream.url } } };
  const manifest = await discoverManifest(config);
  const runtime = await createRuntime({ config, manifest });
  const server = createTackAgentServer({
    manifest,
    runtime,
    codeRuntime: createQuickJSRuntime({ timeoutMs: 1_000, ...(options.toolTimeoutMs ? { toolTimeoutMs: options.toolTimeoutMs } : {}) })
  });
  const client = new Client({ name: "tack-e2e", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await Promise.allSettled([client.close(), server.close(), runtime.close(), downstream.close()]);
    }
  };
}

async function startFailingDownstreamMcp(legacy = false): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    void (legacy ? handleLegacyDownstreamRequest(request, response) : handleDownstreamRequest(request, response));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (typeof address !== "object" || !address) {
    throw new Error("downstream MCP test server did not bind a port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

async function handleDownstreamRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST" || request.url !== "/mcp") {
    response.writeHead(404);
    response.end();
    return;
  }

  const message = await readJson(request);
  if (message.method === "tools/list") {
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: "echo",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"]
          }
        }]
      }
    });
    return;
  }

  if (message.method === "tools/call" && message.params?.name === "echo") {
    if (message.params.arguments?.message === "hang") {
      return;
    }
    if (message.params.arguments?.message === "malformed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not json");
      return;
    }
    if (message.params.arguments?.message === "reset") {
      request.socket.destroy();
      return;
    }
    if (message.params.arguments?.message === "tool-error") {
      writeJson(response, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "expected tool error" }], isError: true }
      });
      return;
    }
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: "downstream exploded" }
    });
    return;
  }

  writeJson(response, 200, {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "method not found" }
  });
}

async function handleLegacyDownstreamRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST" || request.url !== "/mcp") {
    response.writeHead(404);
    response.end();
    return;
  }
  const message = await readJson(request);
  if (message.method === "initialize") {
    response.setHeader("mcp-session-id", "legacy-test-session");
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: "2025-11-25", capabilities: {} }
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    response.writeHead(202);
    response.end();
    return;
  }
  if (message.method === "tools/list") {
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
    });
    return;
  }
  if (message.method === "tools/call") {
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: "downstream exploded" }
    });
    return;
  }
  writeJson(response, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
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
