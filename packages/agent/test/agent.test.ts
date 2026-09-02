import { Buffer } from "node:buffer";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { describeTool, searchOperations } from "@cbxss/tack-codemode";
import { createTackResult, type TackRuntime } from "@cbxss/tack-core";
import { createQuickJSRuntime } from "@cbxss/tack-runtime-quickjs";
import { fakeRuntime, grafanaManifest } from "../../core/test/fixtures.js";
import type { CodeRuntime } from "@cbxss/tack-codemode";

import { createTypeChecker } from "@cbxss/tack-typecheck";

import { createTackAgentServer } from "../src/index.js";
import { extractText } from "./mcp-content.js";

describe("agent search", () => {
  it("finds inferred operations by full path while keeping schemas behind describe", async () => {
    const manifest = grafanaManifest();
    const result = searchOperations(manifest, { query: "unique identifier" });

    expect(result.items[0]).toMatchObject({
      path: "grafana.alerting.rules.get",
      score: expect.any(Number),
      matchedTokens: ["identifier", "unique"]
    });
    expect(result.items[0]).not.toHaveProperty("inputSchema");
    expect(result.items[0]).not.toHaveProperty("toolId");

    const described = await describeTool(manifest, {
      path: result.items[0]?.path ?? ""
    });
    expect(described).toMatchObject({
      inputSchema: expect.objectContaining({
        properties: expect.not.objectContaining({
          operation: expect.anything()
        })
      })
    });
  });
});

describe("JavaScript executor", () => {
  it("executes inferred tools calls and injects split arguments", async () => {
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const runtime = fakeRuntime(calls);
    const codeRuntime = createQuickJSRuntime({ timeoutMs: 5_000 });

    const { createExecutionEngine } = await import("@cbxss/tack-codemode");
    const engine = createExecutionEngine({
      manifest: grafanaManifest(),
      runtime,
      codeRuntime
    });

    const result = await engine.execute(`
const matches = await tools.search({ query: "list rules", limit: 2 });
const details = await tools.describe.tool({ path: matches.items[0].path });
const rules = await tools.grafana.alerting.rules.list();
const datasources = await tools.call("grafana.datasources.list");
emit({ count: 2 });
return { details, rules, datasources };
`);

    expect(result).toMatchObject({
      ok: true,
      emitted: [{ count: 2 }]
    });
    expect(result.result).toMatchObject({
      details: { path: "grafana.alerting.rules.list" },
      rules: { ok: true, data: { toolId: "grafana.alerting_manage_rules" } },
      datasources: { ok: true, data: { toolId: "grafana.list_datasources" } }
    });
    expect(calls).toEqual([
      {
        toolId: "grafana.alerting_manage_rules",
        args: { operation: "list" }
      },
      {
        toolId: "grafana.list_datasources",
        args: {}
      }
    ]);
  });
});

describe("MCP server", () => {
  it("returns the same execute structured output as the direct executor", async () => {
    const manifest = grafanaManifest();
    const directCalls: Array<{ toolId: string; args: unknown }> = [];
    const mcpCalls: Array<{ toolId: string; args: unknown }> = [];
    const codeRuntime: CodeRuntime = {
      name: "test",
      isolation: "none",
      execute: async ({ invoker }) => {
        const search = await invoker.invoke({
          path: "search",
          args: { query: "datasources" }
        });
        const datasources = await invoker.invoke({
          path: "grafana.datasources.list",
          args: {}
        });
        return {
          ok: true,
          result: { search, datasources },
          emitted: [],
          logs: []
        };
      }
    };
    const { createExecutionEngine } = await import("@cbxss/tack-codemode");
    const directEngine = createExecutionEngine({
      manifest,
      runtime: fakeRuntime(directCalls),
      codeRuntime
    });
    const server = createTackAgentServer({
      manifest,
      runtime: fakeRuntime(mcpCalls),
      codeRuntime
    });
    const client = new Client({ name: "tack-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);

    try {
      const directExecuted = await directEngine.execute("return tools.grafana.datasources.list();");
      const direct = directExecuted.result as { readonly search: unknown; readonly datasources: unknown };
      const mcpExecuted = await client.callTool({
        name: "execute",
        arguments: {
          code: "return tools.grafana.datasources.list();"
        }
      });

      expect(mcpExecuted.structuredContent).toEqual({
        status: "completed",
        result: {
          search: direct.search,
          datasources: direct.datasources
        },
        logs: []
      });
      expect(mcpExecuted.isError).toBeUndefined();
      expect(extractText(mcpExecuted.content)).toBe(JSON.stringify({
        search: direct.search,
        datasources: direct.datasources
      }, null, 2));
      expect(directCalls).toEqual([{ toolId: "grafana.list_datasources", args: {} }]);
      expect(mcpCalls).toEqual([{ toolId: "grafana.list_datasources", args: {} }]);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("marks MCP execute responses as errors exactly when the executor result is not ok", async () => {
    const codeRuntime: CodeRuntime = {
      name: "test",
      isolation: "none",
      execute: async () => ({
        ok: false,
        emitted: [],
        logs: [],
        error: {
          phase: "parse",
          message: "synthetic parse failure"
        }
      })
    };
    const server = createTackAgentServer({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime
    });
    const client = new Client({ name: "tack-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);

    try {
      const executed = await client.callTool({
        name: "execute",
        arguments: {
          code: "bad"
        }
      });

      expect(executed.isError).toBe(true);
      expect(executed.structuredContent).toMatchObject({
        status: "error",
        error: {
          phase: "parse",
          message: "synthetic parse failure"
        },
        logs: []
      });
      expect(extractText(executed.content)).toBe("Error: parse: synthetic parse failure");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("formats MCP execute content without dumping the full execution envelope", async () => {
    const codeRuntime: CodeRuntime = {
      name: "test",
      isolation: "none",
      execute: async () => ({
        ok: true,
        result: { final: true },
        emitted: [
          "plain emitted output",
          { type: "text", text: "native MCP text block" },
          { rows: [1, 2, 3] }
        ],
        logs: ["first log", "second log"]
      })
    };
    const server = createTackAgentServer({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime
    });
    const client = new Client({ name: "tack-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);

    try {
      const executed = await client.callTool({
        name: "execute",
        arguments: { code: "emit('x'); return { final: true };" }
      });

      expect(executed.content).toEqual([
        { type: "text", text: "plain emitted output" },
        { type: "text", text: "native MCP text block" },
        { type: "text", text: JSON.stringify({ rows: [1, 2, 3] }, null, 2) },
        { type: "text", text: "Logs:\nfirst log\nsecond log" }
      ]);
      expect(extractText(executed.content)).not.toContain('"executionId"');
      expect(executed.structuredContent).toMatchObject({
        status: "completed",
        result: { final: true },
        emitted: 3,
        logs: ["first log", "second log"]
      });
      expect(executed.structuredContent).not.toHaveProperty("executionId");
      expect(executed.structuredContent).not.toHaveProperty("trace");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("truncates long MCP execute text previews", async () => {
    const codeRuntime: CodeRuntime = {
      name: "test",
      isolation: "none",
      execute: async () => ({
        ok: true,
        result: "x".repeat(40_000),
        emitted: [],
        logs: []
      })
    };
    const server = createTackAgentServer({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime
    });
    const client = new Client({ name: "tack-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);

    try {
      const executed = await client.callTool({
        name: "execute",
        arguments: { code: "return 'x'.repeat(40000);" }
      });

      const text = extractText(executed.content);
      expect(text.length).toBeLessThan(31_000);
      expect(text).toContain("[truncated 10000 chars]");
      expect(executed.structuredContent).toMatchObject({
        status: "completed",
        result: "x".repeat(40_000)
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("truncates long MCP execute error previews", async () => {
    const codeRuntime: CodeRuntime = {
      name: "test",
      isolation: "none",
      execute: async () => ({
        ok: false,
        emitted: [],
        logs: [],
        error: {
          phase: "runtime",
          message: "x".repeat(40_000)
        }
      })
    };
    const server = createTackAgentServer({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime
    });
    const client = new Client({ name: "tack-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);

    try {
      const executed = await client.callTool({
        name: "execute",
        arguments: { code: "throw new Error('x')" }
      });

      const text = extractText(executed.content);
      expect(executed.isError).toBe(true);
      expect(text.length).toBeLessThan(31_000);
      expect(text).toContain("Error: runtime: ");
      expect(text).toContain("[truncated ");
      expect(executed.structuredContent).toMatchObject({
        status: "error",
        error: {
          phase: "runtime",
          message: "x".repeat(40_000)
        },
        logs: []
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("renders emitted text files as MCP text with a 64k file preview cap", async () => {
    const fileText = "x".repeat(70_000);
    const codeRuntime: CodeRuntime = {
      name: "test",
      isolation: "none",
      execute: async () => ({
        ok: true,
        result: undefined,
        emitted: [{
          _tag: "ToolFile",
          name: "datasources.json",
          mimeType: "application/json",
          encoding: "base64",
          data: Buffer.from(fileText, "utf8").toString("base64"),
          byteLength: Buffer.byteLength(fileText)
        }],
        logs: []
      })
    };
    const server = createTackAgentServer({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime
    });
    const client = new Client({ name: "tack-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);

    try {
      const executed = await client.callTool({
        name: "execute",
        arguments: { code: "emit(file); return undefined;" }
      });

      expect(executed.content[0]).toEqual({
        type: "text",
        text: `File output: datasources.json (application/json, ${Buffer.byteLength(fileText)} bytes)`
      });
      const text = extractText(executed.content);
      expect(text).toContain("File output: datasources.json (application/json, 70000 bytes)");
      expect(text).toContain("x".repeat(64_000));
      expect(text).toContain("[truncated 6000 characters]");
      expect(text).not.toContain("[truncated 40000 chars]");
      expect(executed.structuredContent).toMatchObject({
        status: "completed",
        result: null,
        emitted: 1,
        logs: []
      });
      expect(executed.structuredContent).not.toHaveProperty("trace");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("keeps long Grafana MCP outputs concise while preserving structured content", async () => {
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const datasources = Array.from({ length: 1_000 }, (_, index) => ({
      id: index,
      uid: `datasource-${index}`,
      name: `Production datasource ${index}`,
      type: "prometheus",
      url: `https://grafana.example.com/datasources/${index}`,
      access: "proxy"
    }));
    const runtime: TackRuntime = {
      invoke: async (toolId, args) => {
        calls.push({ toolId, args });
        return createTackResult({
          content: [{ type: "text", text: JSON.stringify({ datasources }) }],
          structuredContent: { datasources },
          isError: false
        });
      },
      close: async () => {}
    };
    const server = createTackAgentServer({
      manifest: grafanaManifest(),
      runtime,
      codeRuntime: createQuickJSRuntime({ timeoutMs: 5_000 })
    });
    const client = new Client({ name: "tack-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);

    try {
      const executed = await client.callTool({
        name: "execute",
        arguments: {
          code: "return tools.grafana.datasources.list();"
        }
      });

      const text = extractText(executed.content);
      // In the connection's auto-session a large result is retained as a ref
      // with a preview, not inlined-and-truncated — concise, and nothing lost.
      expect(text.length).toBeLessThan(31_000);
      expect(text).toContain("`$1`");
      expect(text).toContain("retained");
      expect(text).toContain("Production datasource 0");
      expect(text).not.toContain('"executionId"');
      expect(text).not.toContain('"trace"');
      expect(executed.isError).toBeUndefined();
      expect(executed.structuredContent).toMatchObject({
        status: "completed",
        session: expect.stringMatching(/^s_/),
        result: { __tackRef: "$1", type: expect.any(String), preview: expect.anything() }
      });
      expect(executed.structuredContent).not.toHaveProperty("executionId");
      expect(executed.structuredContent).not.toHaveProperty("trace");
      expect(calls).toEqual([{ toolId: "grafana.list_datasources", args: {} }]);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("renders thrown execute defects as opaque MCP tool errors", async () => {
    const codeRuntime: CodeRuntime = {
      name: "test",
      isolation: "none",
      execute: async () => {
        throw new Error("secret internal detail");
      }
    };
    const server = createTackAgentServer({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime
    });
    const client = new Client({ name: "tack-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);

    try {
      const executed = await client.callTool({
        name: "execute",
        arguments: { code: "throw new Error('secret')" }
      });

      expect(executed.isError).toBe(true);
      expect(extractText(executed.content)).toBe("Error: runtime: Internal execute error");
      expect(extractText(executed.content)).not.toContain("secret");
      expect(executed.structuredContent).toMatchObject({
        status: "error",
        error: {
          phase: "runtime",
          message: "Internal execute error"
        },
        logs: []
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("creates agent servers without invoking optional option accessors", async () => {
    const options = {
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime: createQuickJSRuntime({ timeoutMs: 5_000 })
    };
    Object.defineProperty(options, "policy", {
      enumerable: true,
      get() {
        throw new Error("policy getter should not run");
      }
    });
    Object.defineProperty(options, "onAuditEvent", {
      enumerable: true,
      get() {
        throw new Error("audit getter should not run");
      }
    });
    const server = createTackAgentServer(options);
    const client = new Client({ name: "tack-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["deref", "execute", "guide"]);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("keeps the execute description lean and the how-to behind the guide tool", async () => {
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const server = createTackAgentServer({
      manifest: grafanaManifest(),
      runtime: fakeRuntime(calls),
      codeRuntime: createQuickJSRuntime({ timeoutMs: 5_000 })
    });
    const client = new Client({ name: "tack-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["deref", "execute", "guide"]);
      const executeDescription = listed.tools.find((tool) => tool.name === "execute")?.description ?? "";
      expect(executeDescription).toContain("## Available namespaces");
      expect(executeDescription).toContain('guide({ name: "execute" })');
      // the long-form how-to is NOT in the always-loaded description
      expect(executeDescription).not.toContain("## Workflow");
      expect(executeDescription).not.toContain("## Rules");

      const guide = await client.callTool({ name: "guide", arguments: { name: "execute" } });
      expect(extractText(guide.content)).toContain("## Workflow");
      expect(extractText(guide.content)).toContain("__tackRef");

      await expect(client.callTool({
        name: "search",
        arguments: { query: "datasources" }
      })).rejects.toThrow();

      const executed = await client.callTool({
        name: "execute",
        arguments: {
          code: [
            "const matches = await tools.search({ query: 'datasources' });",
            "const datasources = await tools.grafana.datasources.list();",
            "return { matches, datasources };"
          ].join("\n")
        }
      });
      expect(executed.structuredContent).toMatchObject({
        status: "completed",
        result: {
          matches: {
            items: [expect.objectContaining({
              path: "grafana.datasources.list"
            })]
          },
          datasources: {
            ok: true,
            data: { toolId: "grafana.list_datasources" }
          }
        }
      });
      expect(calls).toEqual([{ toolId: "grafana.list_datasources", args: {} }]);

      // a bare `guide()` returns the index of available guides
      const index = await client.callTool({ name: "guide", arguments: {} });
      expect(extractText(index.content)).toContain("`execute`");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("registers one opt-in search_<namespace> tool per namespace when asked", async () => {
    const server = createTackAgentServer({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime: createQuickJSRuntime({ timeoutMs: 5_000 }),
      namespaceTools: true
    });
    const client = new Client({ name: "tack-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "deref",
        "execute",
        "guide",
        "search_grafana"
      ]);

      const found = await client.callTool({ name: "search_grafana", arguments: {} });
      expect((found.structuredContent as { items: Array<{ path: string }> }).items.map((item) => item.path))
        .toContain("grafana.datasources.list");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("refuses sessions when the transport cannot keep one instance per connection", async () => {
    const server = createTackAgentServer({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime: createQuickJSRuntime({ timeoutMs: 5_000 }),
      sessions: false
    });
    const client = new Client({ name: "tack-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["deref", "execute", "guide"]);

      // No persistent session on this transport: an explicit `session` errors,
      // and a bare `execute` runs one-shot.
      const withSession = await client.callTool({
        name: "execute",
        arguments: { session: "s_made-up", code: "return 1;" }
      });
      expect(withSession.isError).toBe(true);
      expect(extractText(withSession.content)).toContain("persistent connection");

      const oneShot = await client.callTool({ name: "execute", arguments: { code: "return 1 + 1;" } });
      expect(oneShot.isError).toBeUndefined();
      expect(oneShot.structuredContent).toMatchObject({ status: "completed", result: 2 });
      expect(oneShot.structuredContent).not.toHaveProperty("session");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("trims execute code input before running it", async () => {
    let receivedCode = "";
    const codeRuntime: CodeRuntime = {
      name: "test",
      isolation: "none",
      execute: async ({ code }) => {
        receivedCode = code;
        return {
          ok: true,
          result: code,
          emitted: [],
          logs: []
        };
      }
    };
    const server = createTackAgentServer({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime
    });
    const client = new Client({ name: "tack-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);

    try {
      await client.callTool({
        name: "execute",
        arguments: {
          code: "  return 1;  "
        }
      });
      expect(receivedCode).toBe("return 1;");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("enforces policy through sandbox search and execute", async () => {
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const audits: unknown[] = [];
    const server = createTackAgentServer({
      manifest: grafanaManifest(),
      runtime: fakeRuntime(calls),
      codeRuntime: createQuickJSRuntime({ timeoutMs: 5_000 }),
      policy: {
        deniedOperations: ["grafana.alerting.*"]
      },
      onAuditEvent: (event) => {
        audits.push(event);
      }
    });
    const client = new Client({ name: "tack-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);

    try {
      const search = await client.callTool({
        name: "execute",
        arguments: {
          code: "return tools.search({ query: 'rules' });"
        }
      });
      expect(search.structuredContent).toMatchObject({
        status: "completed",
        result: { items: [] }
      });

      const executed = await client.callTool({
        name: "execute",
        arguments: {
          code: "return tools.grafana.alerting.rules.list();"
        }
      });
      expect(executed.isError).toBeUndefined();
      expect(executed.structuredContent).toMatchObject({
        status: "completed",
        result: {
          ok: false,
          error: {
            message: expect.stringContaining("denied by policy")
          }
        }
      });
      expect(calls).toEqual([]);
      expect(audits).toEqual([
        expect.objectContaining({
          type: "tool_call",
          path: "grafana.alerting.rules.list",
          allowed: false,
          ok: false
        })
      ]);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});

describe("agent typecheck", () => {
  async function connect(mode: "error" | "warn") {
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const server = createTackAgentServer({
      manifest: grafanaManifest(),
      runtime: fakeRuntime(calls),
      codeRuntime: createQuickJSRuntime({ timeoutMs: 5_000 }),
      typecheck: { checker: createTypeChecker({ manifest: grafanaManifest() }), mode }
    });
    const client = new Client({ name: "tack-test", version: "0.1.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { calls, client, close: () => Promise.allSettled([client.close(), server.close()]) };
  }

  it("blocks a cell with a bad argument key — nothing upstream runs", async () => {
    const { calls, client, close } = await connect("error");
    try {
      const res = await client.callTool({
        name: "execute",
        arguments: { code: 'return (await tools.grafana.alerting.rules.list({ rule_uidx: "x" })).data;' }
      });
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toMatchObject({ status: "error", error: { phase: "typecheck" } });
      const diags = (res.structuredContent as { typeDiagnostics?: unknown[] }).typeDiagnostics;
      expect(Array.isArray(diags) && diags.length).toBeGreaterThan(0);
      expect(extractText(res.content)).toContain("TS2561");
      expect(calls).toEqual([]);
    } finally {
      await close();
    }
  });

  it("typecheck: off runs the cell despite the type error", async () => {
    const { calls, client, close } = await connect("error");
    try {
      const res = await client.callTool({
        name: "execute",
        arguments: {
          code: "return (await tools.grafana.datasources.list()).data;",
          typecheck: "off"
        }
      });
      expect(res.structuredContent).toMatchObject({ status: "completed" });
      expect(calls).toEqual([{ toolId: "grafana.list_datasources", args: {} }]);
    } finally {
      await close();
    }
  });

  it("warn mode runs the cell but attaches diagnostics", async () => {
    const { calls, client, close } = await connect("warn");
    try {
      // Reading `.data` without narrowing on `.ok` is a type error, but the
      // fake runtime returns `{ ok: true, data }` so it's fine at runtime.
      const res = await client.callTool({
        name: "execute",
        arguments: {
          code: "const r = await tools.grafana.datasources.list();\nreturn r.data ?? 'ran';"
        }
      });
      expect(res.structuredContent).toMatchObject({ status: "completed" });
      const diags = (res.structuredContent as { typeDiagnostics?: unknown[] }).typeDiagnostics;
      expect(Array.isArray(diags) && diags.length).toBeGreaterThan(0);
      expect(extractText(res.content)).toContain("type warning");
      expect(calls).toEqual([{ toolId: "grafana.list_datasources", args: {} }]);
    } finally {
      await close();
    }
  });
});
