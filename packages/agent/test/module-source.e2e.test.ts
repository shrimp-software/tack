import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import type { TackConfig } from "@cbxss/tack-core";
import { createQuickJSRuntime } from "@cbxss/tack-runtime-quickjs";
import { createRuntime, discoverManifest } from "@cbxss/tack-sources";
import { createTypeChecker } from "@cbxss/tack-typecheck";

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

async function connectAgent(withTypecheck = false): Promise<ConnectedAgent> {
  const config = markdownConfig();
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

  it("exposes the code-mode tool surface over MCP", async () => {
    const agent = await connectAgent();
    try {
      const { tools } = await agent.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(["deref", "execute", "guide"]);
    } finally {
      await agent.close();
    }
  });

  it("types the discovered module tools through search({ namespace, types: true })", async () => {
    const agent = await connectAgent();
    try {
      const executed = await agent.client.callTool({
        name: "execute",
        arguments: {
          code: `
            const found = await tools.search({ namespace: "docs", types: true });
            return found.items.map((item) => ({
              path: item.path,
              hasTs: typeof item.inputTypeScript === "string" && item.inputTypeScript.includes("Input")
            }));
          `
        }
      });
      expect(executed.structuredContent).toMatchObject({
        status: "completed",
        result: [
          { path: "docs.list", hasTs: true },
          { path: "docs.read", hasTs: true }
        ]
      });
    } finally {
      await agent.close();
    }
  });

  it("retains a large result as a ref and derefs it from the auto-session", async () => {
    const agent = await connectAgent();
    try {
      const big = await agent.client.callTool({
        name: "execute",
        arguments: {
          code: "return Array.from({ length: 400 }, (_, i) => ({ i, blob: 'x'.repeat(50) }));"
        }
      });
      expect((big.structuredContent as { result: { __tackRef?: string } }).result.__tackRef).toBe("$1");
      expect((big.structuredContent as { session?: string }).session).toMatch(/^s_/);
      expect(extractText(big.content)).toContain("retained; use `$1`");

      const counted = await agent.client.callTool({
        name: "execute",
        arguments: { code: "return $1.length;" }
      });
      expect(counted.structuredContent).toMatchObject({ status: "completed", result: 400 });

      const page = await agent.client.callTool({
        name: "deref",
        arguments: { ref: "$1", limit: 2 }
      });
      expect(page.structuredContent).toMatchObject({
        truncated: true,
        value: [{ i: 0 }, { i: 1 }]
      });
    } finally {
      await agent.close();
    }
  });

  it("advertises the docs namespace in the execute description", async () => {
    const agent = await connectAgent();
    try {
      const { tools } = await agent.client.listTools();
      const execute = tools.find((tool) => tool.name === "execute");
      expect(execute?.description).toContain("## Available namespaces");
      expect(execute?.description).toContain("- `docs`");
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

  it("carries scope across bare execute cells and resets on fresh", async () => {
    const agent = await connectAgent();
    try {
      const first = await agent.client.callTool({
        name: "execute",
        arguments: {
          code: `const doc = await tools.call("docs.read", { slug: "architecture" });\nconst title = doc.data.title;`
        }
      });
      expect(first.isError).toBeUndefined();

      const second = await agent.client.callTool({
        name: "execute",
        arguments: { code: `return title.toUpperCase();` }
      });
      expect(second.structuredContent).toMatchObject({ status: "completed", result: "ARCHITECTURE" });

      // `fresh: true` starts a clean scope — the earlier `title` is gone.
      const afterFresh = await agent.client.callTool({
        name: "execute",
        arguments: { fresh: true, code: "return title;" }
      });
      expect(afterFresh.structuredContent).toMatchObject({ status: "error" });
    } finally {
      await agent.close();
    }
  });

  it("streams a live tool-call trace as progress notifications", async () => {
    const agent = await connectAgent();
    const messages: string[] = [];
    try {
      await agent.client.callTool(
        {
          name: "execute",
          arguments: {
            code: `
              await tools.call("docs.list", {});
              return await tools.call("docs.read", { slug: "architecture" });
            `
          }
        },
        {
          onprogress: (progress) => {
            if (typeof progress.message === "string") {
              messages.push(progress.message);
            }
          }
        }
      );

      expect(messages).toContain("→ docs.list");
      expect(messages).toContain("→ docs.read");
      expect(messages.some((line) => /^← docs\.list ok/.test(line))).toBe(true);
      // start precedes completion for each call
      expect(messages.indexOf("→ docs.read")).toBeLessThan(
        messages.findIndex((line) => /^← docs\.read ok/.test(line))
      );
    } finally {
      await agent.close();
    }
  });

  it("typechecks a cell before it runs — a typo'd tool path is blocked", async () => {
    const agent = await connectAgent(true);
    try {
      const blocked = await agent.client.callTool({
        name: "execute",
        arguments: { code: 'return await tools.docs.raed({ slug: "getting-started" });' }
      });
      expect(blocked.isError).toBe(true);
      expect(blocked.structuredContent).toMatchObject({
        status: "error",
        error: { phase: "typecheck" }
      });
      expect(extractText(blocked.content)).toMatch(/raed|read/);

      // a clean cell runs
      const ok = await agent.client.callTool({
        name: "execute",
        arguments: {
          code: 'const r = await tools.docs.read({ slug: "getting-started" });\nreturn r.ok ? r.data.title : null;'
        }
      });
      expect(ok.structuredContent).toMatchObject({ status: "completed", result: "Getting Started" });
    } finally {
      await agent.close();
    }
  });
});
