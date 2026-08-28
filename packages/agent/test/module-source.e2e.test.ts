import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import type { TackConfig } from "@tack/core";
import { createQuickJSRuntime } from "@tack/runtime-quickjs";
import { createRuntime, discoverManifest } from "@tack/sources";

import { createTackAgentServer } from "../src/index.js";
import { extractText } from "./mcp-content.js";

/**
 * End-to-end: register a module source (a plain `.ts` file that serves markdown),
 * stand up the agent MCP server on top of it, and drive it through the `execute`
 * tool exactly as an MCP client would.
 */
const MARKDOWN_SOURCE = fileURLToPath(
  new URL("../../sources/examples/markdown-source.ts", import.meta.url)
);

function markdownConfig(): TackConfig {
  return { servers: { docs: { transport: "module", entry: MARKDOWN_SOURCE } } };
}

interface ConnectedAgent {
  readonly client: Client;
  close(): Promise<void>;
}

async function connectAgent(): Promise<ConnectedAgent> {
  const config = markdownConfig();
  const manifest = await discoverManifest(config);
  const runtime = await createRuntime({ config, manifest });
  const server = createTackAgentServer({
    manifest,
    runtime,
    codeRuntime: createQuickJSRuntime({ timeoutMs: 5_000 })
  });
  const client = new Client({ name: "tack-e2e", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    close: async () => {
      await Promise.allSettled([client.close(), server.close(), runtime.close()]);
    }
  };
}

describe("module source over MCP (e2e)", () => {
  it("discovers the markdown tools into the manifest", async () => {
    const manifest = await discoverManifest(markdownConfig());

    expect(Object.keys(manifest.tools).sort()).toEqual(["docs.list", "docs.read"]);
    expect(manifest.servers["docs"]).toMatchObject({ transport: "module", entry: MARKDOWN_SOURCE });
    expect(manifest.tools["docs.read"]?.inputSchema).toMatchObject({
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"]
    });
  });

  it("exposes only execute and guide over MCP", async () => {
    const agent = await connectAgent();
    try {
      const { tools } = await agent.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(["execute", "guide"]);
    } finally {
      await agent.close();
    }
  });

  it("advertises the docs namespace in the execute description and the guide", async () => {
    const agent = await connectAgent();
    try {
      const { tools } = await agent.client.listTools();
      const execute = tools.find((tool) => tool.name === "execute");
      expect(execute?.description).toContain("## Available namespaces");
      expect(execute?.description).toContain("- `docs`");

      const guide = await agent.client.callTool({
        name: "guide",
        arguments: { name: "execute" }
      });
      const guideText = extractText(guide.content);
      expect(guideText).toContain("# execute");
      expect(guideText).toContain("## Available namespaces");
      expect(guideText).toContain("- `docs`");
    } finally {
      await agent.close();
    }
  });

  it("surfaces the markdown tools to tools.search and tools.describe inside execute", async () => {
    const agent = await connectAgent();
    try {
      const executed = await agent.client.callTool({
        name: "execute",
        arguments: {
          code: `
            const found = await tools.search({ query: "markdown document" });
            const described = await tools.describe.tool({ path: "docs.read" });
            return {
              paths: found.items.map((item) => item.path).sort(),
              slugType: described.inputSchema.properties.slug.type
            };
          `
        }
      });

      expect(executed.structuredContent).toMatchObject({
        status: "completed",
        result: {
          paths: ["docs.list", "docs.read"],
          slugType: "string"
        }
      });
    } finally {
      await agent.close();
    }
  });

  it("lists and reads markdown through the execute tool", async () => {
    const agent = await connectAgent();
    try {
      const executed = await agent.client.callTool({
        name: "execute",
        arguments: {
          code: `
            const listed = await tools.call("docs.list", {});
            const doc = await tools.call("docs.read", { slug: "getting-started" });
            return {
              slugs: listed.data.map((entry) => entry.slug),
              title: doc.data.title,
              markdown: doc.data.markdown
            };
          `
        }
      });

      expect(executed.isError).toBeUndefined();
      expect(executed.structuredContent).toMatchObject({
        status: "completed",
        result: {
          slugs: ["architecture", "getting-started"],
          title: "Getting Started",
          markdown: expect.stringContaining("# Getting Started")
        }
      });
    } finally {
      await agent.close();
    }
  });

  it("propagates a handler failure as a not-ok tool result", async () => {
    const agent = await connectAgent();
    try {
      const executed = await agent.client.callTool({
        name: "execute",
        arguments: {
          code: `return await tools.call("docs.read", { slug: "does-not-exist" });`
        }
      });

      expect(executed.structuredContent).toMatchObject({
        status: "completed",
        result: { ok: false }
      });
    } finally {
      await agent.close();
    }
  });
});
