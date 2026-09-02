import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import type { TackConfig } from "@cbxss/tack-core";
import { createQuickJSRuntime } from "@cbxss/tack-runtime-quickjs";
import { createRuntime, discoverManifest } from "@cbxss/tack-sources";
import { createTypeChecker } from "@cbxss/tack-typecheck";

import { createTackAgentServer } from "../src/index.js";

/**
 * End-to-end: mount a local plugin bundle (one skill + one bundled stdio MCP
 * server), stand up the agent MCP server on it, and drive it through `execute`.
 */
const PLUGIN = fileURLToPath(
  new URL("../../plugin/test/fixtures/acme-plugin/", import.meta.url)
);

function pluginConfig(): TackConfig {
  return { servers: {}, plugins: { acme: { path: PLUGIN } } };
}

interface ConnectedAgent {
  readonly client: Client;
  close(): Promise<void>;
}

async function connectAgent(withTypecheck = false): Promise<ConnectedAgent> {
  const config = pluginConfig();
  const manifest = await discoverManifest(config);
  const runtime = await createRuntime({ config, manifest });
  const server = createTackAgentServer({
    manifest,
    runtime,
    codeRuntime: createQuickJSRuntime({ timeoutMs: 5_000 }),
    ...(withTypecheck
      ? { typecheck: { checker: createTypeChecker({ manifest }), mode: "error" as const } }
      : {})
  });
  const client = new Client({ name: "tack-plugin-e2e", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    close: async () => {
      await Promise.allSettled([client.close(), server.close(), runtime.close()]);
    }
  };
}

describe("plugin source over MCP (e2e)", () => {
  it("discovers the plugin's skill and bundled MCP tool into one namespace", async () => {
    const manifest = await discoverManifest(pluginConfig());
    expect(Object.keys(manifest.tools).sort()).toEqual(["acme.echo", "acme.greet"]);
    expect(manifest.servers["acme"]).toMatchObject({ transport: "plugin" });
  }, 15_000);

  it("advertises the acme namespace in the execute description", async () => {
    const agent = await connectAgent();
    try {
      const { tools } = await agent.client.listTools();
      const execute = tools.find((tool) => tool.name === "execute");
      expect(execute?.description).toContain("## Available namespaces");
      expect(execute?.description).toContain("- `acme`");
    } finally {
      await agent.close();
    }
  }, 15_000);

  it("loads a skill as data and calls a bundled MCP tool from execute", async () => {
    const agent = await connectAgent();
    try {
      const executed = await agent.client.callTool({
        name: "execute",
        arguments: {
          code: `
            const skill = await tools.acme.greet();
            const echoed = await tools.acme.mcp.echo.echo({ text: "pong" });
            return {
              ok: skill.ok && echoed.ok,
              instructions: skill.data.instructions.split("\\n")[0],
              files: skill.data.files.map((f) => f.path),
              echo: echoed.data,
            };
          `
        }
      });

      expect(executed.structuredContent).toMatchObject({
        status: "completed",
        result: {
          ok: true,
          instructions: "# Greet",
          files: ["scripts/hello.sh"],
          echo: { text: "pong" }
        }
      });
    } finally {
      await agent.close();
    }
  }, 15_000);

  it("lists the skill with its SKILL.md description via tools.search", async () => {
    const agent = await connectAgent();
    try {
      const executed = await agent.client.callTool({
        name: "execute",
        arguments: {
          code: `
            const found = await tools.search({ namespace: "acme" });
            return found.items.map((item) => ({ path: item.path, description: item.description }));
          `
        }
      });
      expect(executed.structuredContent).toMatchObject({
        status: "completed",
        result: expect.arrayContaining([
          { path: "acme.greet", description: "Greet a user by name." }
        ])
      });
    } finally {
      await agent.close();
    }
  }, 15_000);

  it("typechecks plugin tool calls before running", async () => {
    const agent = await connectAgent(true);
    try {
      const ok = await agent.client.callTool({
        name: "execute",
        arguments: { code: 'const s = await tools.acme.greet();\nreturn s.ok ? s.data.name : null;' }
      });
      expect(ok.structuredContent).toMatchObject({ status: "completed", result: "greet" });

      const blocked = await agent.client.callTool({
        name: "execute",
        arguments: { code: 'return await tools.acme.gret();' }
      });
      expect(blocked.structuredContent).toMatchObject({
        status: "error",
        error: { phase: "typecheck" }
      });
    } finally {
      await agent.close();
    }
  }, 20_000);
});
