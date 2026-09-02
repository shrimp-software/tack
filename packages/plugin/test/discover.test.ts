import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { PluginServerConfig } from "@cbxss/tack-core";

import { discoverPluginServers } from "../src/discover.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/acme-plugin/", import.meta.url));

function entry(path: string): readonly [string, PluginServerConfig] {
  return ["acme", { transport: "plugin", path }];
}

describe("discoverPluginServers", () => {
  it("emits one DiscoveredServer with the skill and the bundled MCP tool", async () => {
    const [server] = await discoverPluginServers([entry(FIXTURE)]);

    expect(server?.serverId).toBe("acme");
    const byName = new Map(server!.tools.map((t) => [t.name, t]));

    const greet = byName.get("greet");
    expect(greet?.path).toEqual(["greet"]);
    expect(greet?.description).toBe("Greet a user by name.");
    expect(greet?.outputSchema).toMatchObject({ required: ["name", "description", "instructions", "files"] });

    const echo = byName.get("echo");
    expect(echo?.path).toEqual(["mcp", "echo", "echo"]);
    expect(echo?.inputSchema).toMatchObject({ properties: { text: { type: "string" } } });
  }, 15_000);
});
