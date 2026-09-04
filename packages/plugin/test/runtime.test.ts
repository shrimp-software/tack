import { fileURLToPath } from "node:url";

import { buildManifest, type TackConfig } from "@cbxss/tack-core";
import { describe, expect, it } from "vitest";

import { discoverPluginServers } from "../src/discover.js";
import { createPluginToolRuntime } from "../src/runtime.js";

const fixture = fileURLToPath(new URL("./fixtures/acme-plugin/", import.meta.url));

describe("plugin runtime lifecycle", () => {
  it("rejects invocation after close without reopening bundled resources", async () => {
    const config: TackConfig = {
      servers: { acme: { transport: "plugin", path: fixture } }
    };
    const [discovered] = await discoverPluginServers([["acme", config.servers["acme"]!]]);
    const manifest = buildManifest(config, discovered ? [discovered] : []);
    const runtime = await createPluginToolRuntime({
      config,
      tools: Object.values(manifest.tools)
    });

    await expect(runtime.invoke("acme.greet", {})).resolves.toMatchObject({ isError: false });
    await runtime.close();
    await expect(runtime.invoke("acme.greet", {})).rejects.toThrow("Plugin runtime is closed");
    await expect(runtime.close()).resolves.toBeUndefined();
  }, 15_000);
});
