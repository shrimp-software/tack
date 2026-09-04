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
    const downstream = await startFailingDownstreamMcp();
    const config: TackConfig = {
      servers: {
        downstream: { transport: "http", url: downstream.url }
      }
    };
    const manifest = await discoverManifest(config);
    const runtime = await createRuntime({ config, manifest });
    const server = createTackAgentServer({
      manifest,
      runtime,
      codeRuntime: createQuickJSRuntime({ timeoutMs: 1_000 })
    });
    const client = new Client({ name: "tack-e2e", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const executed = await client.callTool({
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
      await Promise.allSettled([client.close(), server.close(), runtime.close(), downstream.close()]);
    }
  });
});

async function startFailingDownstreamMcp(): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    void handleDownstreamRequest(request, response);
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

function readJson(request: IncomingMessage): Promise<{
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: { readonly name?: string };
}> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("error", reject);
    request.on("end", () => resolve(JSON.parse(body) as {
      readonly id?: string | number;
      readonly method?: string;
      readonly params?: { readonly name?: string };
    }));
  });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
