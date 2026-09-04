import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import type { TackConfig } from "@cbxss/tack-core";
import { createQuickJSRuntime } from "@cbxss/tack-runtime-quickjs";
import { createRuntime, discoverManifest } from "@cbxss/tack-sources";

import { createTackAgentServer } from "../src/index.js";
import { startDownstreamMcp } from "./fixtures/downstream-mcp.js";

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
  const downstream = await startDownstreamMcp({ ...(options.legacy ? { legacy: true } : {}) });
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
