import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  BUILTIN_SOURCE_KINDS,
  buildManifest,
  buildServerConfigSchema,
  httpSourceKind,
  manifestConnectionFor,
  moduleSourceKind,
  parseConfig,
  resolveConfigPaths,
  stdioSourceKind,
  type ModuleServerConfig,
  type SourceKind,
  type TackConfig
} from "../src/index.js";

describe("buildServerConfigSchema", () => {
  it("accepts one server of every built-in transport", () => {
    const schema = buildServerConfigSchema(BUILTIN_SOURCE_KINDS);

    expect(schema.parse({ transport: "stdio", command: "node" })).toMatchObject({ transport: "stdio" });
    expect(schema.parse({ transport: "http", url: "https://example.com/mcp" })).toMatchObject({
      transport: "http"
    });
    expect(schema.parse({ transport: "module", entry: "./tools.ts" })).toMatchObject({
      transport: "module"
    });
  });

  it("rejects a transport no registered kind owns", () => {
    const schema = buildServerConfigSchema(BUILTIN_SOURCE_KINDS);
    expect(() => schema.parse({ transport: "carrier-pigeon", note: "hi" })).toThrow();
  });

  it("only accepts the transports of the kinds it was given", () => {
    const stdioOnly = buildServerConfigSchema([stdioSourceKind]);
    expect(stdioOnly.parse({ transport: "stdio", command: "node" })).toMatchObject({ transport: "stdio" });
    expect(() => stdioOnly.parse({ transport: "http", url: "https://example.com/mcp" })).toThrow();
  });

  it("returns the same schema instance for the same kinds array (memoised)", () => {
    expect(buildServerConfigSchema(BUILTIN_SOURCE_KINDS)).toBe(
      buildServerConfigSchema(BUILTIN_SOURCE_KINDS)
    );
  });
});

describe("manifestConnectionFor", () => {
  it("projects each built-in config to its manifest connection", () => {
    expect(
      manifestConnectionFor(BUILTIN_SOURCE_KINDS, {
        transport: "stdio",
        command: "node",
        args: ["server.js"]
      })
    ).toEqual({ transport: "stdio", command: "node", args: ["server.js"] });

    expect(
      manifestConnectionFor(BUILTIN_SOURCE_KINDS, {
        transport: "http",
        url: "https://example.com/mcp"
      })
    ).toEqual({ transport: "http", url: "https://example.com/mcp" });

    expect(
      manifestConnectionFor(BUILTIN_SOURCE_KINDS, { transport: "module", entry: "/abs/tools.ts" })
    ).toEqual({ transport: "module", entry: "/abs/tools.ts" });
  });

  it("returns undefined when no kind owns the transport", () => {
    expect(
      manifestConnectionFor([stdioSourceKind], { transport: "module", entry: "/abs/tools.ts" })
    ).toBeUndefined();
  });
});

describe("resolveConfigPaths", () => {
  const kinds = BUILTIN_SOURCE_KINDS;

  it("anchors a relative module entry and leaves everything else by reference", () => {
    const config: TackConfig = {
      servers: {
        local: { transport: "module", entry: "./tools/local.ts" },
        remote: { transport: "stdio", command: "grafana-mcp" }
      }
    };

    const resolved = resolveConfigPaths(config, "/project", kinds);
    expect(resolved.servers["local"]).toEqual({
      transport: "module",
      entry: "/project/tools/local.ts"
    });
    expect(resolved.servers["remote"]).toBe(config.servers["remote"]);
  });

  it("returns the same config reference when nothing needs rewriting", () => {
    const config: TackConfig = {
      servers: {
        local: { transport: "module", entry: "/abs/tools.ts" },
        remote: { transport: "http", url: "https://example.com/mcp" }
      }
    };

    expect(resolveConfigPaths(config, "/project", kinds)).toBe(config);
  });

  it("only anchors kinds whose resolvePaths is in the given registry", () => {
    const config: TackConfig = {
      servers: { local: { transport: "module", entry: "./tools/local.ts" } }
    };
    // moduleSourceKind (and its resolvePaths) absent → left untouched.
    expect(resolveConfigPaths(config, "/project", [stdioSourceKind, httpSourceKind])).toBe(config);
  });
});

describe("the registry drives parsing and projection", () => {
  // config parsing, path anchoring, and manifest projection all run off the
  // threaded `kinds` — not hardcoded transport branches. A fully typed custom
  // kind swapped in for a built-in transport proves it, no casts required.
  const loudModuleKind: SourceKind<ModuleServerConfig> = {
    transport: "module",
    configSchema: z.object({ transport: z.literal("module"), entry: z.string().min(1) }),
    connection: (config) => ({ transport: "module", entry: config.entry.toUpperCase() }),
    resolvePaths: (config) => config
  };

  const kinds: readonly SourceKind[] = [stdioSourceKind, httpSourceKind, loudModuleKind];

  it("projects a module server through the swapped-in kind", () => {
    const config = parseConfig(
      { servers: { local: { transport: "module", entry: "tools.ts" } } },
      kinds
    );
    const manifest = buildManifest(
      config,
      [{ serverId: "local", tools: [{ name: "run" }] }],
      new Date("2026-07-23T00:00:00.000Z"),
      kinds
    );

    expect(manifest.servers["local"]).toMatchObject({
      id: "local",
      transport: "module",
      entry: "TOOLS.TS",
      tools: ["local.run"]
    });
  });

  it("falls back to BUILTIN_SOURCE_KINDS when none are threaded in", () => {
    const config = parseConfig({
      servers: { local: { transport: "module", entry: "tools.ts" } }
    });
    const manifest = buildManifest(config, [{ serverId: "local", tools: [{ name: "run" }] }]);

    // built-in moduleSourceKind projects the entry verbatim
    expect(manifest.servers["local"]).toMatchObject({ transport: "module", entry: "tools.ts" });
  });

  it("rejects a transport whose kind is not in the given registry", () => {
    expect(() =>
      parseConfig({ servers: { local: { transport: "module", entry: "tools.ts" } } }, [stdioSourceKind])
    ).toThrow();
  });
});
