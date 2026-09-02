import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createQuickJSRuntime } from "@cbxss/tack-runtime-quickjs";
import { fakeRuntime, grafanaManifest } from "../../core/test/fixtures.js";

import { listenTackMcpHttp, type TackMcpHttpHandle } from "../src/http.js";

let handle: TackMcpHttpHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("hosted MCP HTTP server", () => {
  it("serves MCP Streamable HTTP with bearer auth", async () => {
    handle = await startHostedMcp();
    const client = new Client({ name: "tack-http-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      authProvider: {
        token: async () => "secret"
      }
    });

    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: "execute",
        arguments: {
          code: "return tools.search({ query: 'datasources' });"
        }
      });

      expect(result.structuredContent).toMatchObject({
        status: "completed",
        result: {
          items: [expect.objectContaining({
            path: "grafana.datasources.list"
          })]
        }
      });
    } finally {
      await client.close();
    }
  });

  it("requires bearer auth before serving MCP requests", async () => {
    handle = await startHostedMcp();

    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list"
      })
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("serves MCP without bearer auth when no users are configured", async () => {
    handle = await listenTackMcpHttp({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime: createQuickJSRuntime({ timeoutMs: 5_000 })
    }, { port: 0 });
    const client = new Client({ name: "tack-http-open-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url));

    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["deref", "execute", "guide"]);
    } finally {
      await client.close();
    }
  });

  it("rejects browser origins that do not match the request host", async () => {
    handle = await startHostedMcp();

    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer secret",
        "content-type": "application/json",
        origin: "https://evil.example"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list"
      })
    });

    expect(response.status).toBe(403);
  });

  it("applies per-user operation policy to hosted MCP tools", async () => {
    handle = await listenTackMcpHttp({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime: createQuickJSRuntime({ timeoutMs: 5_000 }),
      users: [{
        id: "user-1",
        token: "secret",
        allowedOperations: ["grafana.datasources.*"]
      }]
    }, { port: 0 });
    const client = new Client({ name: "tack-http-policy-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      authProvider: {
        token: async () => "secret"
      }
    });

    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: "execute",
        arguments: {
          code: "return tools.search({ query: 'rules' });"
        }
      });

      expect(result.structuredContent).toMatchObject({
        status: "completed",
        result: { items: [] }
      });
    } finally {
      await client.close();
    }
  });

  it("accepts an explicit empty user list as open MCP", async () => {
    handle = await listenTackMcpHttp({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime: createQuickJSRuntime({ timeoutMs: 5_000 }),
      users: []
    }, { port: 0 });

    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list"
      })
    });

    expect(response.status).not.toBe(401);
  });
});

function startHostedMcp(options: Partial<Parameters<typeof listenTackMcpHttp>[0]> = {}): Promise<TackMcpHttpHandle> {
  return listenTackMcpHttp({
    manifest: grafanaManifest(),
    runtime: fakeRuntime([]),
    codeRuntime: createQuickJSRuntime({ timeoutMs: 5_000 }),
    users: [{ id: "user-1", token: "secret" }],
    ...options
  }, { port: 0 });
}
