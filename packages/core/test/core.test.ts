import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildManifest,
  createTackResult,
  createDefaultConfig,
  dedupeName,
  formatTackError,
  hasRequiredInput,
  loadConfigPromise,
  parseConfig,
  listOperations,
  operationArgs,
  sanitizeId,
  TackConfigError,
  TackGeneratorError,
  TackIoError,
  TackRuntimeError,
  toIdentifier,
  type DiscoveredServer,
  type DiscoveredTool,
  type JsonSchema,
  type TackConfig,
  type TackManifest,
  type TackOperation
} from "../src/index.js";

describe("ids", () => {
  it("sanitizes tool ids", () => {
    expect(sanitizeId("GitHub: Search Issues!")).toBe("github_search_issues");
  });

  it("creates safe JS identifiers", () => {
    expect(toIdentifier("search issues")).toBe("searchIssues");
    expect(toIdentifier("123 call")).toBe("_123Call");
  });

  it("dedupes names with numeric suffixes", () => {
    const used = new Set<string>();
    expect(dedupeName("echo", used)).toBe("echo");
    expect(dedupeName("echo", used)).toBe("echo2");
  });

  it("lists inferred split operations", () => {
    const config: TackConfig = {
      servers: {
        grafana: {
          transport: "stdio",
          command: "grafana-mcp",
          inheritEnv: true
        },
        remoteGrafana: {
          transport: "http",
          url: "https://grafana.example.com/mcp",
          headers: {
            authorization: "Bearer ${GRAFANA_TOKEN}"
          }
        }
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId: "grafana",
          tools: [
            {
              name: "alerting_manage_rules",
              inputSchema: {
                type: "object",
                properties: {
                  operation: { type: "string", enum: ["list", "get", "delete"] },
                  rule_uid: { type: "string" }
                },
                required: ["operation"],
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(listOperations(manifest)).toEqual([
      expect.objectContaining({
        pathString: "alerting.rules.list",
        fullPathString: "grafana.alerting.rules.list",
        toolId: "grafana.alerting_manage_rules",
        injectedArgs: { operation: "list" },
        examples: ["await tools.grafana.alerting.rules.list()"],
        inputSchema: expect.not.objectContaining({ required: ["operation"] })
      }),
      expect.objectContaining({
        pathString: "alerting.rules.get",
        injectedArgs: { operation: "get" }
      }),
      expect.objectContaining({
        pathString: "alerting.rules.delete",
        injectedArgs: { operation: "delete" }
      })
    ]);
  });

  it("removes split discriminators from nested input schema constraints", () => {
    const config: TackConfig = {
      servers: {
        fake: {
          transport: "stdio",
          command: "node"
        }
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId: "fake",
          tools: [
            {
              name: "manage",
              inputSchema: {
                type: "object",
                properties: {
                  operation: { type: "string", enum: ["get"] },
                  uid: { type: "string" }
                },
                required: ["operation"],
                dependencies: {
                  uid: ["operation"]
                },
                dependentRequired: {
                  uid: ["operation"]
                },
                dependentSchemas: {
                  operation: {
                    required: ["operation"]
                  },
                  uid: {
                    properties: {
                      operation: { const: "get" }
                    },
                    required: ["operation"]
                  }
                },
                allOf: [
                  {
                    properties: {
                      operation: { const: "get" }
                    },
                    required: ["operation"]
                  }
                ],
                anyOf: [
                  { required: ["operation"] },
                  { required: ["uid"] }
                ],
                oneOf: [
                  {
                    allOf: [
                      {
                        properties: {
                          operation: { const: "get" }
                        },
                        required: ["operation"]
                      },
                      {
                        properties: {
                          uid: { type: "string" }
                        },
                        required: ["uid"]
                      }
                    ]
                  },
                  {
                    properties: {
                      operation: { const: "list" },
                      cursor: { type: "string" }
                    },
                    required: ["operation"]
                  }
                ],
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(listOperations(manifest)[0]?.inputSchema).toEqual({
      type: "object",
      properties: {
        uid: { type: "string" }
      },
      oneOf: [
        {
          allOf: [
            {
              properties: {
                uid: { type: "string" }
              },
              required: ["uid"]
            }
          ]
        }
      ],
      additionalProperties: false
    });
    expect(hasRequiredInput(listOperations(manifest)[0]?.inputSchema ?? {})).toBe(true);
  });

  it("splits operations from branch discriminator const values", () => {
    const config: TackConfig = {
      servers: {
        fake: {
          transport: "stdio",
          command: "node"
        }
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId: "fake",
          tools: [
            {
              name: "manage",
              inputSchema: {
                type: "object",
                properties: {
                  operation: { type: "string" }
                },
                required: ["operation"],
                oneOf: [
                  {
                    properties: {
                      operation: { const: "get" },
                      uid: { type: "string" }
                    },
                    required: ["operation", "uid"]
                  },
                  {
                    properties: {
                      operation: {
                        oneOf: [
                          { const: "list" }
                        ]
                      },
                      cursor: { type: "string" }
                    },
                    required: ["operation"]
                  }
                ],
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(listOperations(manifest).map((operation) => [
      operation.fullPathString,
      operation.injectedArgs,
      operation.inputSchema
    ])).toEqual([
      [
        "fake.get",
        { operation: "get" },
        {
          type: "object",
          oneOf: [
            {
              properties: {
                uid: { type: "string" }
              },
              required: ["uid"]
            }
          ],
          additionalProperties: false
        }
      ],
      [
        "fake.list",
        { operation: "list" },
        {
          type: "object",
          oneOf: [
            {
              properties: {
                cursor: { type: "string" }
              }
            }
          ],
          additionalProperties: false
        }
      ]
    ]);
  });

  it("ignores inherited JSON Schema keywords when planning operations", () => {
    const config: TackConfig = {
      servers: {
        fake: {
          transport: "stdio",
          command: "node"
        }
      }
    };
    const inputSchema = Object.assign(
      Object.create({
        properties: {
          operation: { type: "string", enum: ["list"] },
          value: { type: "string" }
        },
        required: ["operation", "value"],
        allOf: [
          {
            properties: {
              operation: { const: "list" }
            },
            required: ["operation"]
          }
        ]
      }),
      {
        type: "object",
        additionalProperties: false
      }
    );
    const manifest = buildManifest(
      config,
      [
        {
          serverId: "fake",
          tools: [
            {
              name: "manage",
              inputSchema
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );
    const operations = listOperations(manifest);

    expect(operations).toHaveLength(1);
    expect(operations[0]?.fullPathString).toBe("fake.manage");
    expect(operations[0]?.injectedArgs).toBeUndefined();
    expect(hasRequiredInput(operations[0]?.inputSchema ?? {})).toBe(false);
  });

  it("ignores inherited manifest tool fields when planning operations", () => {
    const tool = Object.assign(
      Object.create({
        description: "INHERITED_DESCRIPTION",
        examples: ["inherited example"],
        outputSchema: {
          type: "object",
          properties: {
            secret: { type: "string" }
          }
        }
      }),
      {
        id: "fake.manage",
        serverId: "fake",
        namespaceName: "fake",
        sdkName: "manage",
        upstreamName: "manage",
        inputSchema: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["list"] }
          },
          required: ["operation"],
          additionalProperties: false
        }
      }
    );
    const missingOwnFields = Object.assign(
      Object.create({
        id: "fake.inherited",
        serverId: "fake",
        namespaceName: "fake",
        sdkName: "inherited",
        upstreamName: "inherited",
        inputSchema: {
          type: "object"
        }
      }),
      {}
    );
    const manifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        fake: {
          id: "fake",
          transport: "stdio",
          command: "node",
          tools: ["fake.manage", "fake.inherited"]
        }
      },
      tools: {
        "fake.manage": tool,
        "fake.inherited": missingOwnFields
      }
    };
    const operations = listOperations(manifest);

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      fullPathString: "fake.list",
      toolId: "fake.manage",
      injectedArgs: { operation: "list" }
    });
    expect(operations[0]?.description).toBeUndefined();
    expect(operations[0]?.outputSchema).toBeUndefined();
    expect(operations[0]?.examples).toEqual(["await tools.fake.list()"]);
  });

  it("ignores malformed manifest tool entries when planning operations", () => {
    const manifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        fake: {
          id: "fake",
          transport: "stdio",
          command: "node",
          tools: ["fake.echo", "fake.null"]
        }
      },
      tools: {
        "fake.echo": {
          id: "fake.echo",
          serverId: "fake",
          namespaceName: "fake",
          sdkName: "echo",
          upstreamName: "echo",
          inputSchema: { type: "object" }
        },
        "fake.null": null
      }
    } as unknown as TackManifest;

    expect(listOperations(manifest).map((operation) => operation.fullPathString)).toEqual([
      "fake.echo"
    ]);
    expect(listOperations(null as unknown as TackManifest)).toEqual([]);
  });

  it("ignores accessor manifest tool entries and fields when planning operations", () => {
    const tools = {
      "fake.echo": {
        id: "fake.echo",
        serverId: "fake",
        namespaceName: "fake",
        sdkName: "echo",
        upstreamName: "echo",
        inputSchema: { type: "object" }
      },
      "fake.poisoned": {
        id: "fake.poisoned",
        get serverId() {
          throw new Error("serverId getter should not run");
        },
        namespaceName: "fake",
        sdkName: "poisoned",
        upstreamName: "poisoned",
        inputSchema: { type: "object" }
      } as unknown as TackManifest["tools"][string]
    };
    Object.defineProperty(tools, "fake.accessor", {
      enumerable: true,
      get() {
        throw new Error("tool entry getter should not run");
      }
    });
    const manifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        fake: {
          id: "fake",
          transport: "stdio",
          command: "node",
          tools: ["fake.echo", "fake.poisoned", "fake.accessor"]
        }
      },
      tools
    } as unknown as TackManifest;

    expect(listOperations(manifest).map((operation) => operation.fullPathString)).toEqual([
      "fake.echo"
    ]);
  });

  it("ignores accessor JSON Schema keywords when checking required input", () => {
    const schema = { type: "object" };
    Object.defineProperty(schema, "required", {
      enumerable: true,
      get() {
        throw new Error("required getter should not run");
      }
    });

    expect(hasRequiredInput(schema as JsonSchema)).toBe(false);
  });

  it("ignores accessor JSON Schema properties when planning split operations", () => {
    const properties = {
      value: { type: "string" }
    };
    Object.defineProperty(properties, "operation", {
      enumerable: true,
      get() {
        throw new Error("operation property getter should not run");
      }
    });
    const manifest = buildManifest(
      {
        servers: {
          fake: {
            transport: "stdio",
            command: "node"
          }
        }
      },
      [
        {
          serverId: "fake",
          tools: [
            {
              name: "manage",
              inputSchema: {
                type: "object",
                properties,
                additionalProperties: false
              } as JsonSchema
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(listOperations(manifest).map((operation) => [
      operation.fullPathString,
      operation.injectedArgs
    ])).toEqual([
      ["fake.manage", undefined]
    ]);
  });

  it("ignores accessor and non-enumerable JSON Schema array entries when planning operations", () => {
    const enumValues = ["secret"];
    Object.defineProperty(enumValues, "0", {
      enumerable: true,
      get() {
        throw new Error("enum getter should not run");
      }
    });
    Object.defineProperty(enumValues, "1", {
      enumerable: true,
      value: "list"
    });
    const oneOf: unknown[] = [];
    Object.defineProperty(oneOf, "0", {
      enumerable: false,
      value: {
        properties: {
          operation: { const: "secret" }
        },
        required: ["operation"]
      }
    });
    Object.defineProperty(oneOf, "1", {
      enumerable: true,
      get() {
        throw new Error("oneOf getter should not run");
      }
    });
    const manifest = buildManifest(
      {
        servers: {
          fake: {
            transport: "stdio",
            command: "node"
          }
        }
      },
      [
        {
          serverId: "fake",
          tools: [
            {
              name: "manage",
              inputSchema: {
                type: "object",
                properties: {
                  operation: { type: "string", enum: enumValues }
                },
                required: ["operation"],
                oneOf
              } as JsonSchema
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(listOperations(manifest).map((operation) => [
      operation.fullPathString,
      operation.injectedArgs,
      operation.inputSchema
    ])).toEqual([
      [
        "fake.list",
        { operation: "list" },
        {
          type: "object"
        }
      ]
    ]);
  });

  it("does not recurse forever on cyclic JSON Schema data while planning operations", () => {
    const inputSchema: Record<string, unknown> = {
      type: "object",
      allOf: []
    };
    inputSchema["allOf"] = [inputSchema];
    const manifest = buildManifest(
      {
        servers: {
          fake: {
            transport: "stdio",
            command: "node"
          }
        }
      },
      [
        {
          serverId: "fake",
          tools: [
            {
              name: "manage",
              inputSchema: inputSchema as JsonSchema
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(hasRequiredInput(inputSchema as JsonSchema)).toBe(false);
    expect(listOperations(manifest).map((operation) => operation.fullPathString)).toEqual([
      "fake.manage"
    ]);
  });

  it("normalizes operation args from own enumerable data without invoking getters", () => {
    const injectedArgs = Object.create(null) as Record<string, string>;
    injectedArgs["operation"] = "list";
    injectedArgs["__proto__"] = "literal";
    Object.defineProperty(injectedArgs, "poisonedInjected", {
      enumerable: true,
      get() {
        throw new Error("injected arg getter should not run");
      }
    });
    Object.defineProperty(injectedArgs, "nonEnumerableInjected", {
      enumerable: false,
      value: "secret"
    });
    const operation = {
      injectedArgs
    } as TackOperation;
    const args = {
      keep: "safe"
    };
    Object.defineProperty(args, "poisoned", {
      enumerable: true,
      get() {
        throw new Error("caller arg getter should not run");
      }
    });
    Object.defineProperty(args, "nonEnumerable", {
      enumerable: false,
      value: "secret"
    });

    const normalized = operationArgs(operation, args);

    expect(Object.getPrototypeOf(normalized)).toBe(null);
    expect(normalized["keep"]).toBe("safe");
    expect(normalized["operation"]).toBe("list");
    expect(normalized["__proto__"]).toBe("literal");
    expect(Object.keys(normalized)).toEqual(["keep", "operation", "__proto__"]);
  });

  it("treats accessor operation injected args as absent", () => {
    const operation = {
      get injectedArgs() {
        throw new Error("operation injectedArgs getter should not run");
      }
    } as unknown as TackOperation;

    expect(operationArgs(operation, { keep: "safe" })).toEqual({ keep: "safe" });
  });
});

describe("defaults", () => {
  it("uses quickjs as the default code runtime", () => {
    expect(createDefaultConfig().runtime).toMatchObject({
      type: "quickjs",
      timeoutMs: 30_000,
      memoryMb: 128,
      maxStackBytes: 1_000_000,
      maxOutputBytes: 1_000_000,
      maxToolCalls: 100,
      maxToolRequestBytes: 1_000_000,
      maxToolResponseBytes: 1_000_000
    });
  });
});

describe("errors", () => {
  it("constructs Tack errors from own data without invoking accessors", () => {
    const cause = new Error("cause");
    const ioArgs = {
      message: "io failed",
      cause
    };
    Object.defineProperty(ioArgs, "path", {
      enumerable: true,
      get() {
        throw new Error("path getter should not run");
      }
    });

    const runtimeArgs = {
      message: "runtime failed",
      toolId: "grafana.echo"
    };
    Object.defineProperty(runtimeArgs, "serverId", {
      enumerable: true,
      get() {
        throw new Error("serverId getter should not run");
      }
    });

    expect(new TackConfigError({ message: "config failed" }).message).toBe("config failed");
    expect(new TackIoError(ioArgs as unknown as ConstructorParameters<typeof TackIoError>[0]))
      .toMatchObject({ message: "io failed", cause });
    expect(new TackRuntimeError(runtimeArgs as unknown as ConstructorParameters<typeof TackRuntimeError>[0]))
      .toMatchObject({ message: "runtime failed", toolId: "grafana.echo" });
    expect(new TackGeneratorError({ message: "generation failed", cause }))
      .toMatchObject({ message: "generation failed", cause });
  });

  it("formats own data messages without invoking inherited or accessor fields", () => {
    const accessorMessage = {};
    Object.defineProperty(accessorMessage, "message", {
      enumerable: true,
      get() {
        throw new Error("message getter should not run");
      }
    });
    Object.defineProperty(accessorMessage, "toString", {
      enumerable: true,
      value() {
        throw new Error("toString should not run");
      }
    });
    const inheritedMessage = Object.create({
      message: "inherited"
    });
    const prototypeMessageError = new Error("safe");
    Object.defineProperty(prototypeMessageError, "message", {
      configurable: true,
      get() {
        throw new Error("error message getter should not run");
      }
    });

    expect(formatTackError(new Error("native"))).toBe("native");
    expect(formatTackError(new TackConfigError({
      message: "Invalid Tack config at tack.config.json",
      cause: new Error("config.shape was removed; Tack now infers operation paths automatically.")
    }))).toBe(
      "Invalid Tack config at tack.config.json: config.shape was removed; Tack now infers operation paths automatically."
    );
    expect(formatTackError({ message: 123 })).toBe("123");
    expect(formatTackError(accessorMessage)).toBe("[object Object]");
    expect(formatTackError(inheritedMessage)).toBe("[object Object]");
    expect(formatTackError(prototypeMessageError)).toBe("Error");
    expect(formatTackError("plain")).toBe("plain");
  });
});

describe("config", () => {
  it("parses static security policy and audit config", () => {
    expect(parseConfig({
      servers: {
        grafana: {
          transport: "stdio",
          command: "grafana-mcp",
          inheritEnv: true
        },
        remoteGrafana: {
          transport: "http",
          url: "https://grafana.example.com/mcp"
        }
      },
      runtime: {
        maxToolRequestBytes: 1000,
        maxToolResponseBytes: 2000
      },
      security: {
        allowedOperations: ["grafana.dashboards.*"],
        deniedOperations: ["grafana.admin.*"],
        auditLog: {
          path: ".tack/audit.jsonl"
        }
      },
      service: {
        host: "127.0.0.1",
        port: 8787,
        maxRequestBytes: 12345,
        rateLimit: {
          requests: 60,
          windowMs: 60_000
        },
        users: [
          {
            id: "agent",
            token: "secret",
            allowedOperations: ["grafana.dashboards.*"],
            deniedOperations: ["grafana.admin.*"],
            rateLimit: {
              requests: 10,
              windowMs: 1_000
            }
          }
        ]
      }
    })).toMatchObject({
      servers: {
        grafana: {
          inheritEnv: true
        },
        remoteGrafana: {
          transport: "http",
          url: "https://grafana.example.com/mcp"
        }
      },
      runtime: {
        maxToolRequestBytes: 1000,
        maxToolResponseBytes: 2000
      },
      security: {
        allowedOperations: ["grafana.dashboards.*"],
        deniedOperations: ["grafana.admin.*"],
        auditLog: {
          path: ".tack/audit.jsonl"
        }
      },
      service: {
        host: "127.0.0.1",
        port: 8787,
        maxRequestBytes: 12345,
        users: [
          {
            id: "agent",
            token: "secret"
          }
        ]
      }
    });
  });

  it("parses config from own enumerable data without invoking accessors", () => {
    const servers = {
      safe: {
        transport: "stdio",
        command: "node"
      }
    };
    Object.defineProperty(servers, "poisoned", {
      enumerable: true,
      get() {
        throw new Error("server entry getter should not run");
      }
    });
    Object.defineProperty(servers.safe, "args", {
      enumerable: true,
      get() {
        throw new Error("server field getter should not run");
      }
    });

    expect(parseConfig({ servers })).toEqual({
      servers: {
        safe: {
          transport: "stdio",
          command: "node"
        }
      }
    });
  });

  it("rejects cyclic config data before validation walks it", () => {
    const input: { servers: unknown; runtime?: unknown } = {
      servers: {
        safe: {
          transport: "stdio",
          command: "node"
        }
      }
    };
    input.runtime = input;

    expect(() => parseConfig(input)).toThrow("Cyclic Tack config data is not supported");
  });

  it("preserves built-in-looking config keys as own data", () => {
    const serverId = "constructor";
    expect(parseConfig({
      servers: {
        [serverId]: {
          transport: "stdio",
          command: "node"
        }
      }
    })).toEqual({
      servers: {
        [serverId]: {
          transport: "stdio",
          command: "node"
        }
      }
    });
  });

  it("rejects removed shape config", () => {
    expect(() => parseConfig({
      servers: {
        fake: {
          transport: "stdio",
          command: "node"
        }
      },
      shape: {
        tools: {}
      }
    })).toThrow("config.shape was removed; Tack now infers operation paths automatically.");
  });
});

describe("config path resolution", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tack-config-paths-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function loadConfigWith(servers: Record<string, unknown>): Promise<TackConfig> {
    const path = join(dir, "tack.config.json");
    await writeFile(path, JSON.stringify({ servers }), "utf8");
    return loadConfigPromise(path);
  }

  it("anchors a relative module entry to the config file's directory", async () => {
    const config = await loadConfigWith({
      local: { transport: "module", entry: "./tools/local.ts" }
    });

    const entry = config.servers["local"];
    expect(entry?.transport).toBe("module");
    expect(entry && "entry" in entry ? entry.entry : "").toBe(join(dir, "tools", "local.ts"));
  });

  it("leaves an absolute module entry untouched", async () => {
    const absolute = join(dir, "elsewhere", "local.ts");
    const config = await loadConfigWith({
      local: { transport: "module", entry: absolute }
    });

    const entry = config.servers["local"];
    expect(entry && "entry" in entry ? entry.entry : "").toBe(absolute);
    expect(isAbsolute(absolute)).toBe(true);
  });

  it("leaves configs with no module source structurally unchanged", async () => {
    const config = await loadConfigWith({
      grafana: { transport: "stdio", command: "grafana-mcp" },
      remote: { transport: "http", url: "https://grafana.example.com/mcp" }
    });

    expect(config.servers).toEqual({
      grafana: { transport: "stdio", command: "grafana-mcp" },
      remote: { transport: "http", url: "https://grafana.example.com/mcp" }
    });
  });
});

describe("manifest", () => {
  it("builds stable canonical ids and infers operation paths from discovery", () => {
    const config: TackConfig = {
      servers: {
        github: {
          transport: "stdio",
          command: "github-mcp",
          inheritEnv: true
        }
      }
    };

    const manifest = buildManifest(
      config,
      [
        {
          serverId: "github",
          tools: [
            {
              name: "search issues",
              description: "Search issues",
              inputSchema: { type: "object" }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(manifest.tools["github.search_issues"]).toMatchObject({
      id: "github.search_issues",
      namespaceName: "github",
      sdkName: "searchIssues",
      upstreamName: "search issues"
    });
    expect(listOperations(manifest).map((operation) => operation.fullPathString)).toEqual([
      "github.issues.search"
    ]);
    expect(manifest.servers["github"]?.inheritEnv).toBe(true);
  });

  it("does not read inherited removed shape config while building manifests directly", () => {
    const config: TackConfig = {
      servers: {
        github: {
          transport: "stdio",
          command: "github-mcp"
        }
      }
    };

    const manifest = buildManifest(
      config,
      [
        {
          serverId: "github",
          tools: [
            {
              name: "search issues",
              inputSchema: {
                type: "object",
                properties: {
                  operation: { type: "string", enum: ["list"] }
                },
                required: ["operation"],
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(manifest.tools["github.search_issues"]).toMatchObject({
      sdkName: "searchIssues"
    });
    expect(listOperations(manifest).map((operation) => operation.fullPathString)).toEqual([
      "github.search.issues.list"
    ]);
  });

  it("records HTTP MCP server connection metadata from discovery", () => {
    const config: TackConfig = {
      servers: {
        grafana: {
          transport: "http",
          url: "https://grafana.example.com/mcp",
          headers: {
            authorization: "Bearer ${GRAFANA_TOKEN}"
          }
        }
      }
    };

    const manifest = buildManifest(
      config,
      [
        {
          serverId: "grafana",
          tools: [
            {
              name: "search_dashboards",
              inputSchema: { type: "object" }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(manifest.servers["grafana"]).toMatchObject({
      id: "grafana",
      transport: "http",
      url: "https://grafana.example.com/mcp",
      headers: {
        authorization: "Bearer ${GRAFANA_TOKEN}"
      },
      tools: ["grafana.search_dashboards"]
    });
  });

  it("ignores inherited server connection metadata when building manifests", () => {
    const serverConfig = Object.assign(
      Object.create({
        args: ["--inherited"],
        env: { TOKEN: "INHERITED_TOKEN" },
        inheritEnv: true,
        cwd: "/tmp/inherited"
      }),
      {
        transport: "stdio" as const,
        command: "node"
      }
    );
    const config: TackConfig = {
      servers: {
        fake: serverConfig
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId: "fake",
          tools: [{ name: "echo" }]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(manifest.servers["fake"]).toEqual({
      id: "fake",
      transport: "stdio",
      command: "node",
      tools: ["fake.echo"]
    });
  });

  it("ignores accessor server config and discovered tool fields when building manifests", () => {
    const servers = {
      fake: {
        transport: "stdio" as const,
        get command() {
          throw new Error("command getter should not run");
        }
      }
    };
    Object.defineProperty(servers, "poisoned", {
      enumerable: true,
      get() {
        throw new Error("server entry getter should not run");
      }
    });
    const discoveredTool = {
      get name() {
        throw new Error("tool name getter should not run");
      }
    } as unknown as DiscoveredTool;
    const manifest = buildManifest(
      {
        servers: servers as unknown as TackConfig["servers"]
      },
      [
        {
          serverId: "fake",
          tools: [discoveredTool]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(Object.keys(manifest.servers)).toEqual([]);
    expect(Object.keys(manifest.tools)).toEqual([]);
  });

  it("snapshots manifest string arrays and records from own data", () => {
    const args = ["--safe"];
    const env = { TOKEN: "safe" };
    const discoveredTools = [{ name: "echo" }];
    Object.defineProperty(discoveredTools, "1", {
      enumerable: true,
      get() {
        throw new Error("discovered tool entry getter should not run");
      }
    });
    const manifest = buildManifest(
      {
        servers: {
        fake: {
          transport: "stdio",
          command: "node",
          args,
          env
        }
        }
      },
      [
        {
          serverId: "fake",
          tools: discoveredTools
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );
    Object.defineProperty(args, "0", {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error("args entry getter should not run");
      }
    });
    Object.defineProperty(env, "TOKEN", {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error("env entry getter should not run");
      }
    });

    expect(manifest.servers["fake"]?.args).toEqual(["--safe"]);
    expect(manifest.servers["fake"]?.env).toEqual({ TOKEN: "safe" });
  });

  it("ignores inherited discovered tool fields when building manifests", () => {
    const inheritedOnlyTool = Object.create({
      name: "inherited_only",
      inputSchema: {
        type: "object",
        required: ["secret"]
      }
    }) as DiscoveredTool;
    const ownNameTool = Object.assign(
      Object.create({
        description: "INHERITED_DESCRIPTION",
        inputSchema: {
          type: "object",
          properties: {
            secret: { type: "string" }
          },
          required: ["secret"],
          additionalProperties: false
        },
        outputSchema: {
          type: "object",
          properties: {
            secret: { type: "string" }
          }
        },
        annotations: {
          inherited: true
        }
      }),
      {
        name: "echo"
      }
    ) as DiscoveredTool;
    const manifest = buildManifest(
      {
        servers: {
          fake: {
            transport: "stdio",
            command: "node"
          }
        }
      },
      [
        {
          serverId: "fake",
          tools: [inheritedOnlyTool, ownNameTool]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(Object.keys(manifest.tools)).toEqual(["fake.echo"]);
    expect(manifest.servers["fake"]?.tools).toEqual(["fake.echo"]);
    expect(manifest.tools["fake.echo"]).toMatchObject({
      id: "fake.echo",
      upstreamName: "echo",
      inputSchema: {
        type: "object",
        additionalProperties: true
      }
    });
    expect(manifest.tools["fake.echo"]?.description).toBeUndefined();
    expect(manifest.tools["fake.echo"]?.outputSchema).toBeUndefined();
    expect(manifest.tools["fake.echo"]?.annotations).toBeUndefined();
    expect(hasRequiredInput(manifest.tools["fake.echo"]?.inputSchema ?? {})).toBe(false);
  });

  it("ignores inherited discovered server fields when building manifests", () => {
    const inheritedServerId = Object.create({
      serverId: "inherited",
      tools: [{ name: "echo" }]
    }) as DiscoveredServer;
    const inheritedTools = Object.assign(
      Object.create({
        tools: [{ name: "echo" }]
      }),
      {
        serverId: "fake"
      }
    ) as DiscoveredServer;
    const manifest = buildManifest(
      {
        servers: {
          inherited: {
            transport: "stdio",
            command: "node"
          },
          fake: {
            transport: "stdio",
            command: "node"
          }
        }
      },
      [inheritedServerId, inheritedTools],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(Object.keys(manifest.servers)).toEqual(["fake"]);
    expect(Object.keys(manifest.tools)).toEqual([]);
    expect(manifest.servers["fake"]).toEqual({
      id: "fake",
      transport: "stdio",
      command: "node",
      tools: []
    });
  });

  it("dedupes server namespaces deterministically and reserves generated SDK names", () => {
    const config: TackConfig = {
      servers: {
        "foo-bar": { transport: "stdio", command: "node" },
        foo_bar: { transport: "stdio", command: "node" },
        close: { transport: "stdio", command: "node" },
        index: { transport: "stdio", command: "node" },
        tack: { transport: "stdio", command: "node" },
        types: { transport: "stdio", command: "node" }
      }
    };
    const discovered = [
      { serverId: "close", tools: [{ name: "echo" }] },
      { serverId: "index", tools: [{ name: "echo" }] },
      { serverId: "tack", tools: [{ name: "echo" }] },
      { serverId: "types", tools: [{ name: "echo" }] },
      { serverId: "foo_bar", tools: [{ name: "echo" }] },
      { serverId: "foo-bar", tools: [{ name: "echo" }] }
    ];

    const manifest = buildManifest(config, discovered, new Date("2026-07-23T00:00:00.000Z"));

    expect(manifest.tools["foo-bar.echo"]?.namespaceName).toBe("fooBar");
    expect(manifest.tools["foo_bar.echo"]?.namespaceName).toBe("fooBar2");
    expect(manifest.tools["close.echo"]?.namespaceName).toBe("close2");
    expect(manifest.tools["index.echo"]?.namespaceName).toBe("index2");
    expect(manifest.tools["tack.echo"]?.namespaceName).toBe("tack2");
    expect(manifest.tools["types.echo"]?.namespaceName).toBe("types2");
    expect(listOperations(manifest).map((operation) => operation.fullPathString)).toEqual([
      "close2.echo",
      "fooBar.echo",
      "fooBar2.echo",
      "index2.echo",
      "tack2.echo",
      "types2.echo"
    ]);
  });

  it("preserves prototype-looking server ids as own manifest keys", () => {
    const serverId = "__proto__";
    const config: TackConfig = {
      servers: {
        [serverId]: { transport: "stdio", command: "node" }
      }
    };
    const manifest = buildManifest(
      config,
      [
        { serverId, tools: [{ name: "echo" }] }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(Object.hasOwn(manifest.servers, serverId)).toBe(true);
    expect(Object.keys(manifest.servers)).toEqual([serverId]);
    expect(Object.entries(manifest.servers)).toEqual([
      [
        serverId,
        {
          id: serverId,
          transport: "stdio",
          command: "node",
          tools: [`${serverId}.echo`]
        }
      ]
    ]);
    expect(JSON.parse(JSON.stringify(manifest)).servers).toEqual({
      [serverId]: {
        id: serverId,
        transport: "stdio",
        command: "node",
        tools: [`${serverId}.echo`]
      }
    });
    expect(listOperations(manifest).map((operation) => operation.fullPathString)).toEqual([
      "proto.echo"
    ]);
  });

  it("reserves Windows device names for generated SDK files", () => {
    const config: TackConfig = {
      servers: {
        con: { transport: "stdio", command: "node" },
        aux: { transport: "stdio", command: "node" },
        com1: { transport: "stdio", command: "node" },
        lpt9: { transport: "stdio", command: "node" },
        normal: { transport: "stdio", command: "node" }
      }
    };
    const manifest = buildManifest(
      config,
      [
        { serverId: "con", tools: [{ name: "echo" }] },
        { serverId: "aux", tools: [{ name: "echo" }] },
        { serverId: "com1", tools: [{ name: "echo" }] },
        { serverId: "lpt9", tools: [{ name: "echo" }] },
        { serverId: "normal", tools: [{ name: "echo" }] }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(manifest.tools["con.echo"]?.namespaceName).toBe("con2");
    expect(manifest.tools["aux.echo"]?.namespaceName).toBe("aux2");
    expect(manifest.tools["com1.echo"]?.namespaceName).toBe("com12");
    expect(manifest.tools["lpt9.echo"]?.namespaceName).toBe("lpt92");
    expect(manifest.tools["normal.echo"]?.namespaceName).toBe("normal");
  });

  it("assigns inferred collision suffixes independent of discovery tool order", () => {
    const config: TackConfig = {
      servers: {
        fake: { transport: "stdio", command: "node" }
      }
    };
    const one = {
      name: "one",
      inputSchema: {
        type: "object",
        properties: { oneOnly: { type: "string" } },
        required: ["oneOnly"],
        additionalProperties: false
      }
    };
    const two = {
      name: "two",
      inputSchema: {
        type: "object",
        properties: { twoOnly: { type: "string" } },
        required: ["twoOnly"],
        additionalProperties: false
      }
    };
    const manifest = buildManifest(
      config,
      [{ serverId: "fake", tools: [one, two] }],
      new Date("2026-07-23T00:00:00.000Z")
    );
    const reversedManifest = buildManifest(
      config,
      [{ serverId: "fake", tools: [two, one] }],
      new Date("2026-07-23T00:00:00.000Z")
    );

    const operations = listOperations(manifest);
    const reversedOperations = listOperations(reversedManifest);
    expect(operations.map((operation) => [
      operation.toolId,
      operation.fullPathString,
      operation.inputSchema
    ])).toEqual(reversedOperations.map((operation) => [
      operation.toolId,
      operation.fullPathString,
      operation.inputSchema
    ]));
    expect(operations.map((operation) => operation.fullPathString)).toEqual([
      "fake.one",
      "fake.two"
    ]);
    expect(operations[0]?.toolId).toBe("fake.one");
    expect(operations[0]?.inputSchema).toMatchObject({
      required: ["oneOnly"]
    });
  });

  it("assigns prefix-free operation paths for SDK-compatible trees", () => {
    const config: TackConfig = {
      servers: {
        fake: { transport: "stdio", command: "node" }
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId: "fake",
          tools: [
            { name: "foo" },
            { name: "foo_bar" },
            { name: "foo_bar_baz" }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(listOperations(manifest).map((operation) => [
      operation.toolId,
      operation.fullPathString
    ])).toEqual([
      ["fake.foo", "fake.foo"],
      ["fake.foo_bar", "fake.fooBar"],
      ["fake.foo_bar_baz", "fake.fooBarBaz"]
    ]);
  });

  it("does not assign callable then leaves that would make SDK clients thenable", () => {
    const config: TackConfig = {
      servers: {
        fake: { transport: "stdio", command: "node" }
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId: "fake",
          tools: [
            { name: "then" },
            { name: "nested_then" }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    expect(listOperations(manifest).map((operation) => [
      operation.toolId,
      operation.fullPathString
    ])).toEqual([
      ["fake.nested_then", "fake.nestedThen"],
      ["fake.then", "fake.then2"]
    ]);
  });
});

describe("result", () => {
  it("extracts text and structured JSON", () => {
    const result = createTackResult<{ message: string }>({
      content: [{ type: "text", text: "hello" }],
      structuredContent: { message: "hello" },
      isError: false
    });

    expect(result.text()).toBe("hello");
    expect(result.json()).toEqual({ message: "hello" });
  });

  it("ignores inherited MCP result fields", () => {
    const raw = Object.create({
      content: [{ type: "text", text: "{\"message\":\"from prototype\"}" }],
      structuredContent: { message: "from prototype" },
      isError: true
    }) as Record<string, unknown>;
    raw.extra = "own field";

    const result = createTackResult<{ message: string }>(raw);

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toBeUndefined();
    expect(result.text()).toBe("");
    expect(() => result.json()).toThrow("Tack result has no structuredContent or text JSON to parse");
  });

  it("ignores inherited MCP text content part fields", () => {
    const inheritedTextPart = Object.create({
      type: "text",
      text: "from inherited text part"
    });
    const result = createTackResult({
      content: [
        inheritedTextPart,
        { type: "text", text: "{\"message\":\"from own text part\"}" }
      ]
    });

    expect(result.text()).toBe("{\"message\":\"from own text part\"}");
    expect(result.json()).toEqual({ message: "from own text part" });
  });

  it("ignores accessor MCP result fields", () => {
    const raw = {
      content: [{ type: "text", text: "{\"message\":\"safe\"}" }]
    };
    Object.defineProperty(raw, "structuredContent", {
      enumerable: true,
      get() {
        throw new Error("structuredContent getter should not run");
      }
    });
    Object.defineProperty(raw, "isError", {
      enumerable: true,
      get() {
        throw new Error("isError getter should not run");
      }
    });

    const result = createTackResult<{ message: string }>(raw);

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toBeUndefined();
    expect(result.text()).toBe("{\"message\":\"safe\"}");
    expect(result.json()).toEqual({ message: "safe" });
  });

  it("ignores accessor MCP content parts", () => {
    const poisonedPart = {
      type: "text"
    };
    Object.defineProperty(poisonedPart, "text", {
      enumerable: true,
      get() {
        throw new Error("content text getter should not run");
      }
    });
    const content = [
      { type: "text", text: "{\"message\":\"safe\"}" }
    ];
    Object.defineProperty(content, "1", {
      enumerable: true,
      get() {
        throw new Error("content item getter should not run");
      }
    });
    content.push(poisonedPart as { type: string; text: string });
    const result = createTackResult({
      content
    });

    expect(result.text()).toBe("{\"message\":\"safe\"}");
    expect(result.json()).toEqual({ message: "safe" });
  });

  it("does not re-read raw text content after creating a result", () => {
    const content = [
      { type: "text", text: "{\"message\":\"snapshot\"}" }
    ];
    const raw = { content };
    const result = createTackResult<{ message: string }>(raw);
    Object.defineProperty(raw, "content", {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error("content getter should not run");
      }
    });
    Object.defineProperty(content, "0", {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error("content item getter should not run");
      }
    });

    expect(result.text()).toBe("{\"message\":\"snapshot\"}");
    expect(result.json()).toEqual({ message: "snapshot" });
  });
});
