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

describe("registering a new source kind", () => {
  // A genuinely new transport still needs its arm on `TackServerConfig` in
  // types.ts (TS unions are static) — this proves config parsing and manifest
  // projection need no other core edit: just the SourceKind, threaded in.
  const echoSchema = z.object({ transport: z.literal("echo"), phrase: z.string().min(1) });
  const echoKind = {
    transport: "echo",
    configSchema: echoSchema,
    connection: (config: z.infer<typeof echoSchema>) => ({
      transport: "module" as const,
      entry: config.phrase
    })
  } as unknown as SourceKind;

  const kinds: readonly SourceKind[] = [...BUILTIN_SOURCE_KINDS, echoKind];

  it("parses a config containing the new kind", () => {
    const config = parseConfig(
      { servers: { hi: { transport: "echo", phrase: "hello" } } },
      kinds
    );
    expect(config.servers["hi"]).toEqual({ transport: "echo", phrase: "hello" });
  });

  it("rejects the new kind when its SourceKind is not threaded in", () => {
    expect(() =>
      parseConfig({ servers: { hi: { transport: "echo", phrase: "hello" } } })
    ).toThrow();
  });

  it("projects the new kind into a manifest with no changes to buildManifest", () => {
    const config = parseConfig(
      { servers: { hi: { transport: "echo", phrase: "hello.ts" } } },
      kinds
    );
    const manifest = buildManifest(
      config,
      [{ serverId: "hi", tools: [{ name: "greet" }] }],
      new Date("2026-07-23T00:00:00.000Z"),
      kinds
    );

    expect(manifest.servers["hi"]).toMatchObject({
      id: "hi",
      transport: "module",
      entry: "hello.ts",
      tools: ["hi.greet"]
    });
  });
});
