import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { buildManifest, type TackConfig, type TackManifest } from "@tack/core";
import { generateDocsPromise, generateSdkPromise } from "../src/index.js";

const generatorTestDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(generatorTestDir, "..", "..", "..");
let tmpPath: string | undefined;

afterEach(async () => {
  if (tmpPath) {
    await rm(tmpPath, { recursive: true, force: true });
    tmpPath = undefined;
  }
});

describe("generateSdk", () => {
  it("generates markdown docs from the operation graph", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-docs-generator-"));
    const outFile = join(tmpPath, "tools.md");
    const config: TackConfig = {
      servers: {
        grafana: { transport: "stdio", command: "grafana-mcp" }
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
              description: "Manage Grafana alert rules.",
              inputSchema: {
                type: "object",
                properties: {
                  operation: { type: "string", enum: ["list"] },
                  rule_uid: { type: "string" }
                },
                required: ["operation"],
                additionalProperties: false
              },
              outputSchema: {
                type: "object",
                properties: { count: { type: "number" } },
                required: ["count"],
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateDocsPromise({ manifest, outFile, title: "Grafana Tools" });

    const docs = await readFile(outFile, "utf8");
    expect(docs).toContain("# Grafana Tools");
    expect(docs).toContain("### `grafana.alerting.rules.list`");
    expect(docs).toContain("Manage Grafana alert rules.");
    expect(docs).toContain('- Injected args: `{"operation":"list"}`');
    expect(docs).toContain("await tools.grafana.alerting.rules.list()");
    expect(docs).toContain("export interface GrafanaAlertingRulesListInput");
    expect(docs).toContain("export interface GrafanaAlertingRulesListOutput");
    expect(docs).not.toContain("operation:");
  });

  it("generates markdown docs with inferred examples", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-docs-generator-fences-"));
    const outFile = join(tmpPath, "tools.md");
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
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: {
                  text: { type: "string" }
                },
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateDocsPromise({ manifest, outFile });

    const docs = await readFile(outFile, "utf8");
    expect(docs).toContain("```ts\nawait tools.fake.echo()\n```");
    expect(docs).toContain("Input:\n\n```ts\nexport interface FakeEchoInput");
  });

  it("generates markdown docs with inline metadata that survives backticks", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-docs-generator-inline-code-"));
    const outFile = join(tmpPath, "tools.md");
    const serverId = "fake`server";
    const toolName = "echo`tool";
    const config: TackConfig = {
      servers: {
        [serverId]: { transport: "stdio", command: "node" }
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId,
          tools: [
            {
              name: toolName,
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateDocsPromise({ manifest, outFile });

    const docs = await readFile(outFile, "utf8");
    expect(docs).toContain("- Tool ID: ``fake`server.echo_tool``");
    expect(docs).toContain("- Upstream: ``echo`tool``");
    expect(docs).not.toContain("- Tool ID: `fake`server.echo_tool`");
    expect(docs).not.toContain("- Upstream: `echo`tool`");
  });

  it("generates markdown docs without invoking option accessors", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-docs-generator-options-"));
    const outFile = join(tmpPath, "tools.md");
    const manifest = buildManifest(
      {
        servers: {
          fake: { transport: "stdio", command: "node" }
        }
      },
      [
        {
          serverId: "fake",
          tools: [{ name: "echo" }]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );
    const options = {
      manifest,
      outFile
    };
    Object.defineProperty(options, "title", {
      enumerable: true,
      get() {
        throw new Error("docs title getter should not run");
      }
    });

    await generateDocsPromise(options);

    const docs = await readFile(outFile, "utf8");
    expect(docs).toContain("# Tack Tool Docs");
  });

  it("generates typed fluent SDK files", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-"));
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
            {
              name: "add_activity_to_incident",
              description: "Add activity to an incident.",
              inputSchema: {
                type: "object",
                properties: {
                  a: { type: "number" },
                  b: { type: "number" }
                },
                required: ["a", "b"],
                additionalProperties: false
              },
              outputSchema: {
                type: "object",
                properties: { value: { type: "number" } },
                required: ["value"],
                additionalProperties: false
              }
            },
            {
              name: "manage_rules",
              description: "Manage alerting rules.",
              inputSchema: {
                type: "object",
                properties: {
                  operation: { type: "string", enum: ["list", "get", "create"] },
                  uid: { type: "string" }
                },
                required: ["operation"],
                additionalProperties: false
              }
            },
            {
              name: "get_status",
              description: "Get API URL status.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            },
            {
              name: "fetch_api_url_uid",
              description: "Exercise generic casing without domain acronym tables.",
              inputSchema: {
                type: "object",
                properties: {
                  http_status: { type: "number" }
                },
                required: ["http_status"],
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const index = await readFile(join(tmpPath, "index.ts"), "utf8");
    const fake = await readFile(join(tmpPath, "fake.ts"), "utf8");
    const types = await readFile(join(tmpPath, "types.ts"), "utf8");

    expect(index).toContain('from "./fake.js"');
    expect(index).toContain('export type * from "./types.js";');
    expect(index).toContain('export { createFakeClient } from "./fake.js";');
    expect(index).toContain('export type { FakeClient } from "./fake.js";');
    expect(index).toContain("const manifest = JSON.parse(");
    expect(index).toContain('\\"fake.manage_rules\\"');
    expect(index).toContain("readonly config?: TackConfig;");
    expect(index).toContain('const config = ownDataValue<TackConfig>(options, "config") ?? await loadConfigPromise(ownDataValue<string>(options, "configPath") ?? DEFAULT_CONFIG_PATH);');
    expect(index).toContain("function ownDataValue<T>(value: unknown, key: PropertyKey): T | undefined");
    expect(index).toContain("function ownDataRuntime(runtime: TackRuntime): TackRuntime");
    expect(index).not.toContain("options.config");
    expect(index).not.toContain("options.configPath");
    expect(index).toContain('const { createRuntime } = await import("@tack/sources");');
    expect(index).toContain("createRuntime({ config, manifest })");
    expect(index).not.toContain('import { createRuntime } from "@tack/sources";');
    expect(index).not.toContain("discoverManifest");
    expect(index).not.toContain("FakeActivitiesAddToIncidentInput");
    expect(index).not.toContain("Add activity to an incident.");
    expect(index).not.toContain("http_status");
    expect(fake).toContain('readonly "activities":');
    expect(fake).toContain('readonly "rules":');
    expect(fake).toContain('"addToIncident"(args: FakeActivitiesAddToIncidentInput)');
    expect(fake).toContain('"list"(args?: FakeRulesListInput)');
    expect(fake).toContain('"get"(args?: FakeRulesGetInput)');
    expect(fake).toContain("FakeRulesListOutput,");
    expect(fake).toContain('clientRuntime.invoke<FakeRulesListOutput>("fake.manage_rules", withInjectedArgs(args ?? {}, { "operation": "list" }))');
    expect(fake).toContain('readonly "status":');
    expect(fake).toContain('"get"(args?: FakeStatusGetInput)');
    expect(fake).toContain("Get API URL status.");
    expect(fake).toContain("@example");
    expect(fake).toContain("await tools.fake.status.get()");
    expect(types).toContain("export interface FakeActivitiesAddToIncidentInput");
    expect(types).toContain("export interface FakeActivitiesAddToIncidentOutput");
    expect(types).toContain("export interface FakeRulesListInput");
    expect(types).toContain("export interface FakeFetchApiUrlUidInput");
    expect(types).not.toContain("FakeProtocolFetchAPIURLUIDInput");
    expect(types).not.toContain("operation:");

    await writeFile(join(tmpPath, "usage.generated.ts"), [
      'import { createFakeClient, createTackClientFromRuntime, type FakeClient, type FakeActivitiesAddToIncidentInput, type TackClient } from "./index.js";',
      'import type { TackRuntime } from "@tack/core";',
      "",
      "const runtime: TackRuntime = {",
      "  invoke: async () => ({",
      "    raw: {},",
      "    isError: false,",
      "    structuredContent: undefined,",
      "    text: () => \"\",",
      "    json: <T>() => ({}) as T",
      "  }),",
      "  close: async () => {}",
      "};",
      "",
      "const addArgs: FakeActivitiesAddToIncidentInput = { a: 1, b: 2 };",
      "const client: TackClient = createTackClientFromRuntime(runtime);",
      "const fake: FakeClient = createFakeClient(runtime);",
      "async function run(): Promise<void> {",
      "  await client.fake.activities.addToIncident(addArgs);",
      "  await client.fake.rules.list();",
      "  await fake.fetchApiUrlUid({ http_status: 200 });",
      "  await client.close();",
      "}",
      "",
      "void run();",
      ""
    ].join("\n"), "utf8");
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("validates generated SDK options without invoking accessors", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-options-"));
    const options = {
      outDir: tmpPath
    };
    Object.defineProperty(options, "manifest", {
      enumerable: true,
      get() {
        throw new Error("manifest getter should not run");
      }
    });

    await expect(generateSdkPromise(options as never)).rejects.toThrow(
      "Invalid Tack manifest: manifest must be an object"
    );
  });

  it("renders untrusted descriptions and multiline examples as safe JSDoc text", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-jsdoc-"));
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
            {
              name: "echo",
              description: [
                "@deprecated should stay prose",
                "normal line",
                "  @internal should stay indented prose",
                "closing */ comment stays contained"
              ].join("\r\n"),
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const fake = await readFile(join(tmpPath, "fake.ts"), "utf8");
    expect(fake).toContain(" * \\@deprecated should stay prose");
    expect(fake).toContain(" * normal line");
    expect(fake).toContain(" *   \\@internal should stay indented prose");
    expect(fake).toContain(" * closing * / comment stays contained");
    expect(fake).toContain(" * @example");
    expect(fake).toContain(" * await tools.fake.echo()");
    expect(fake).not.toContain("\n@deprecated should stay example text");
    expect(fake).not.toContain("\n  @internal should stay indented example text");
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("executes generated SDK clients against a runtime", async () => {
    tmpPath = await mkdtemp(join(generatorTestDir, ".runtime-sdk-"));
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
            {
              name: "manage_rules",
              inputSchema: {
                type: "object",
                properties: {
                  operation: { type: "string", enum: ["list", "get"] },
                  rule_uid: { type: "string" }
                },
                required: ["operation"],
                additionalProperties: false
              }
            },
            {
              name: "get_status",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });
    await writeFile(join(tmpPath, "runtime.generated.ts"), [
      'import { createFakeClient, createTackClientFromRuntime } from "./index.js";',
      'import type { FakeRulesListInput } from "./index.js";',
      'import type { TackRuntime } from "@tack/core";',
      "",
      "const calls: Array<{ toolId: string; args: unknown }> = [];",
      "let closed = false;",
      "const runtime: TackRuntime = {",
      "  invoke: async (toolId, args) => {",
      "    calls.push({ toolId, args });",
      "    return {",
      "      raw: { toolId, args },",
      "      isError: false,",
      "      structuredContent: { toolId, args },",
      "      text: () => JSON.stringify({ toolId, args }),",
      "      json: <T>() => ({ toolId, args }) as T",
      "    };",
      "  },",
      "  close: async () => {",
      "    closed = true;",
      "  }",
      "};",
      "",
      "const client = createTackClientFromRuntime(runtime);",
      "const fake = createFakeClient(runtime);",
      "Object.defineProperty(runtime, \"invoke\", {",
      "  configurable: true,",
      "  enumerable: true,",
      "  get() {",
      "    throw new Error(\"runtime invoke getter should not run\");",
      "  }",
      "});",
      "Object.defineProperty(runtime, \"close\", {",
      "  configurable: true,",
      "  enumerable: true,",
      "  get() {",
      "    throw new Error(\"runtime close getter should not run\");",
      "  }",
      "});",
      "const poisonedArgs = {};",
      "Object.defineProperty(poisonedArgs, \"rule_uid\", {",
      "  enumerable: true,",
      "  get() {",
      "    throw new Error(\"caller arg getter should not run\");",
      "  }",
      "});",
      "await client.fake.rules.list(poisonedArgs as FakeRulesListInput);",
      "const poisonedOptionalArgs = {};",
      "Object.defineProperty(poisonedOptionalArgs, \"ignored\", {",
      "  enumerable: true,",
      "  get() {",
      "    throw new Error(\"optional arg getter should not run\");",
      "  }",
      "});",
      "await fake.status.get(poisonedOptionalArgs as Parameters<typeof fake.status.get>[0]);",
      "await client.close();",
      "const expected = [",
      "  { toolId: \"fake.manage_rules\", args: { operation: \"list\" } },",
      "  { toolId: \"fake.get_status\", args: {} }",
      "];",
      "if (JSON.stringify(calls) !== JSON.stringify(expected)) {",
      "  throw new Error(`Unexpected runtime calls: ${JSON.stringify(calls)}`);",
      "}",
      "if (!closed) {",
      "  throw new Error(\"Expected client.close() to close the runtime\");",
      "}",
      ""
    ].join("\n"), "utf8");

    const run = spawnSync("bun", [join(tmpPath, "runtime.generated.ts")], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("");
    expect(run.status).toBe(0);
  });

  it("preserves proto-looking injected split values at runtime", async () => {
    tmpPath = await mkdtemp(join(generatorTestDir, ".proto-injected-sdk-"));
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
            {
              name: "route",
              inputSchema: {
                type: "object",
                properties: {
                  operation: { type: "string", enum: ["__proto__"] },
                  query: { type: "string" }
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

    await generateSdkPromise({ manifest, outDir: tmpPath });
    const fake = await readFile(join(tmpPath, "fake.ts"), "utf8");
    expect(fake).toContain('"operation": "__proto__"');
    expect(fake).toContain("function withInjectedArgs");
    await writeFile(join(tmpPath, "proto-injected.generated.ts"), [
      'import { createTackClientFromRuntime } from "./index.js";',
      'import type { TackRuntime } from "@tack/core";',
      "",
      "let invokedArgs: unknown;",
      "const runtime: TackRuntime = {",
      "  invoke: async (_toolId, args) => {",
      "    invokedArgs = args;",
      "    return {",
      "      raw: {},",
      "      isError: false,",
      "      structuredContent: undefined,",
      "      text: () => \"\",",
      "      json: <T>() => ({}) as T",
      "    };",
      "  },",
      "  close: async () => {}",
      "};",
      "",
      "const client = createTackClientFromRuntime(runtime);",
      "await client.fake.route.proto({ query: \"errors\" });",
      "if (typeof invokedArgs !== \"object\" || invokedArgs === null || Array.isArray(invokedArgs)) {",
      "  throw new Error(\"Expected object args\");",
      "}",
      "if (!Object.hasOwn(invokedArgs, \"operation\")) {",
      "  throw new Error(`Missing injected operation arg: ${JSON.stringify(invokedArgs)}`);",
      "}",
      "if ((invokedArgs as Record<string, unknown>).operation !== \"__proto__\") {",
      "  throw new Error(`Unexpected injected operation value: ${String((invokedArgs as Record<string, unknown>).operation)}`);",
      "}",
      ""
    ].join("\n"), "utf8");

    const run = spawnSync("bun", [join(tmpPath, "proto-injected.generated.ts")], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("");
    expect(run.status).toBe(0);
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("generates split inputs from the selected discriminator branch", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-split-branch-"));
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
                    allOf: [
                      {
                        properties: {
                          operation: { const: "get" }
                        },
                        required: ["operation"],
                        additionalProperties: false
                      },
                      {
                        properties: {
                          uid: { type: "string" }
                        },
                        required: ["uid"],
                        additionalProperties: false
                      }
                    ]
                  },
                  {
                    properties: {
                      operation: { const: "list" },
                      cursor: { type: "string" }
                    },
                    required: ["operation"],
                    additionalProperties: false
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

    await generateSdkPromise({ manifest, outDir: tmpPath });
    const fake = await readFile(join(tmpPath, "fake.ts"), "utf8");
    const types = await readFile(join(tmpPath, "types.ts"), "utf8");
    expect(fake).toContain('"get"(args: FakeGetInput)');
    expect(fake).toContain('"list"(args?: FakeListInput)');
    expect(types).toContain("uid: string;");
    expect(types).toContain("cursor?: string;");
    expect(types).not.toContain("operation:");
    await writeFile(join(tmpPath, "split-branch.generated.ts"), [
      'import { createTackClientFromRuntime } from "./index.js";',
      'import type { TackRuntime } from "@tack/core";',
      "",
      "const runtime: TackRuntime = {",
      "  invoke: async () => ({",
      "    raw: {},",
      "    isError: false,",
      "    structuredContent: undefined,",
      "    text: () => \"\",",
      "    json: <T>() => ({}) as T",
      "  }),",
      "  close: async () => {}",
      "};",
      "",
      "async function run(): Promise<void> {",
      "  const client = createTackClientFromRuntime(runtime);",
      "  await client.fake.get({ uid: \"abc\" });",
      "  await client.fake.list();",
      "}",
      "",
      "void run();",
      ""
    ].join("\n"), "utf8");
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("does not generate callable then methods that make clients thenable", async () => {
    tmpPath = await mkdtemp(join(generatorTestDir, ".thenable-sdk-"));
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
            {
              name: "then",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            },
            {
              name: "nested_then",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });
    const fake = await readFile(join(tmpPath, "fake.ts"), "utf8");
    expect(fake).not.toContain('"then"(args');
    expect(fake).toContain('"nestedThen"(args?: FakeNestedThenInput)');
    expect(fake).toContain('"then2"(args?: FakeThen2Input)');
    await writeFile(join(tmpPath, "thenable.generated.ts"), [
      'import { createFakeClient } from "./index.js";',
      'import type { TackRuntime } from "@tack/core";',
      "",
      "const calls: Array<{ toolId: string; args: unknown }> = [];",
      "const runtime: TackRuntime = {",
      "  invoke: async (toolId, args) => {",
      "    calls.push({ toolId, args });",
      "    return {",
      "      raw: {},",
      "      isError: false,",
      "      structuredContent: undefined,",
      "      text: () => \"\",",
      "      json: <T>() => ({}) as T",
      "    };",
      "  },",
      "  close: async () => {}",
      "};",
      "",
      "const fake = createFakeClient(runtime);",
      "const nestedThen = fake.nestedThen;",
      "await Promise.race([",
      "  Promise.resolve(fake),",
      "  new Promise((_, reject) => setTimeout(() => reject(new Error(\"fake client is thenable\")), 50))",
      "]);",
      "await Promise.race([",
      "  Promise.resolve(nestedThen),",
      "  new Promise((_, reject) => setTimeout(() => reject(new Error(\"nested client is thenable\")), 50))",
      "]);",
      "if (calls.length !== 0) {",
      "  throw new Error(`Promise resolution invoked tools: ${JSON.stringify(calls)}`);",
      "}",
      "await fake.then2();",
      "await nestedThen();",
      "const expected = [",
      "  { toolId: \"fake.then\", args: {} },",
      "  { toolId: \"fake.nested_then\", args: {} }",
      "];",
      "if (JSON.stringify(calls) !== JSON.stringify(expected)) {",
      "  throw new Error(`Unexpected calls: ${JSON.stringify(calls)}`);",
      "}",
      ""
    ].join("\n"), "utf8");

    const run = spawnSync("bun", [join(tmpPath, "thenable.generated.ts")], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("");
    expect(run.status).toBe(0);
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("dedupes generated type names when distinct paths share a type base", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-type-collision-"));
    const outDirA = join(tmpPath, "a");
    const outDirB = join(tmpPath, "b");
    const docsFile = join(tmpPath, "tools.md");
    const config: TackConfig = {
      servers: {
        fake: { transport: "stdio", command: "node" }
      }
    };
    const split = {
      name: "foo",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["bar"] }
        },
        required: ["operation"],
        additionalProperties: false
      }
    };
    const flat = {
      name: "foo_bar",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId: "fake",
          tools: [split, flat]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );
    const reversedManifest = buildManifest(
      config,
      [
        {
          serverId: "fake",
          tools: [flat, split]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: outDirA });
    await generateSdkPromise({ manifest: reversedManifest, outDir: outDirB });
    await generateDocsPromise({ manifest, outFile: docsFile });

    const fake = await readFile(join(outDirA, "fake.ts"), "utf8");
    const types = await readFile(join(outDirA, "types.ts"), "utf8");
    const reversedTypes = await readFile(join(outDirB, "types.ts"), "utf8");
    const docs = await readFile(docsFile, "utf8");
    expect(fake).toContain('"bar"(args?: FakeFooBarInput)');
    expect(fake).toContain('"fooBar"(args?: FakeFooBar2Input)');
    expect(types).toContain("export interface FakeFooBarInput");
    expect(types).toContain("export interface FakeFooBar2Input");
    expect(reversedTypes).toBe(types);
    expect(docs).toContain("export interface FakeFooBarInput");
    expect(docs).toContain("export interface FakeFooBar2Input");
  });

  it("does not let schema-emitted type names collide with SDK helper result types", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-schema-helper-collision-"));
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
            {
              name: "echo",
              inputSchema: {
                type: "object",
                definitions: {
                  FakeEchoResult: {
                    title: "FakeClient",
                    type: "object",
                    properties: {
                      inputValue: { type: "string" },
                      title: { type: "string", title: "PropertyTitleMetadata" }
                    },
                    additionalProperties: false
                  }
                },
                $defs: {
                  TackResult: {
                    title: "FakeEchoResult",
                    type: "object",
                    properties: {
                      helperValue: { type: "string" }
                    },
                    additionalProperties: false
                  }
                },
                properties: {
                  value: { $ref: "#/definitions/FakeEchoResult" },
                  helper: { $ref: "#/$defs/TackResult" }
                },
                additionalProperties: false
              },
              outputSchema: {
                title: "TackResult",
                type: "object",
                definitions: {
                  FakeEchoInput: {
                    type: "object",
                    properties: {
                      outputNestedValue: { type: "string" }
                    },
                    additionalProperties: false
                  }
                },
                properties: {
                  outputValue: { type: "string" },
                  nested: { $ref: "#/definitions/FakeEchoInput" }
                },
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const types = await readFile(join(tmpPath, "types.ts"), "utf8");
    expect(types).not.toContain('import type { TackResult } from "@tack/core";');
    expect(types).not.toContain("export interface TackResult");
    expect(types).not.toContain("export interface FakeEchoResult");
    expect(types).not.toContain("export interface FakeClient");
    expect(types).toContain("export interface FakeEchoOutput");
    expect(types).toContain("export interface FakeEchoInputFakeEchoResult");
    expect(types).toContain("export interface FakeEchoInputTackResult");
    expect(types).toContain("export interface FakeEchoOutputFakeEchoInput");
    expect(types).toContain("title?: string;");
    expect(types).toContain('export type FakeEchoResult = import("@tack/core").TackResult<FakeEchoOutput>;');
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("ignores schema naming metadata and prose annotations in generated types", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-schema-metadata-"));
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
            {
              name: "echo",
              inputSchema: {
                id: "LegacyInjectedInputName",
                $id: "InjectedInputName",
                title: "TitleInjectedInputName",
                description: "root schema prose */ export interface Pwned { value: true } /**",
                markdownDescription: "markdown schema prose",
                $comment: "comment schema prose",
                type: "object",
                properties: {
                  value: {
                    $id: "InjectedPropertyName",
                    title: "TitleInjectedPropertyName",
                    description: "property schema prose",
                    markdownDescription: "property markdown prose",
                    $comment: "property comment prose",
                    type: "string"
                  }
                },
                required: ["value"],
                additionalProperties: false
              },
              outputSchema: {
                $id: "InjectedOutputName",
                description: "output schema prose",
                type: "object",
                properties: {
                  ok: { type: "boolean" }
                },
                required: ["ok"],
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const types = await readFile(join(tmpPath, "types.ts"), "utf8");
    expect(types).toContain("export interface FakeEchoInput");
    expect(types).toContain("export interface FakeEchoOutput");
    expect(types).not.toContain("InjectedInputName");
    expect(types).not.toContain("LegacyInjectedInputName");
    expect(types).not.toContain("TitleInjectedInputName");
    expect(types).not.toContain("InjectedPropertyName");
    expect(types).not.toContain("TitleInjectedPropertyName");
    expect(types).not.toContain("InjectedOutputName");
    expect(types).not.toContain("schema prose");
    expect(types).not.toContain("schema markdown");
    expect(types).not.toContain("schema comment");
    expect(types).not.toContain("Pwned");
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("ignores accessor schema data before compiling generated types", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-schema-accessors-"));
    const properties = {
      safe: { type: "string" }
    };
    Object.defineProperty(properties, "poisoned", {
      enumerable: true,
      get() {
        throw new Error("schema property getter should not run");
      }
    });
    const inputSchema = {
      type: "object",
      properties,
      required: ["safe"],
      additionalProperties: false
    };
    Object.defineProperty(inputSchema, "description", {
      enumerable: true,
      get() {
        throw new Error("schema description getter should not run");
      }
    });
    const manifest = buildManifest(
      {
        servers: {
          fake: { transport: "stdio", command: "node" }
        }
      },
      [
        {
          serverId: "fake",
          tools: [
            {
              name: "echo",
              inputSchema: inputSchema as unknown as TackManifest["tools"][string]["inputSchema"]
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const types = await readFile(join(tmpPath, "types.ts"), "utf8");
    expect(types).toContain("safe: string;");
    expect(types).not.toContain("poisoned");
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("ignores non-enumerable schema array branches before compiling generated types", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-schema-array-enumerability-"));
    const oneOf: unknown[] = [];
    Object.defineProperty(oneOf, "0", {
      value: {
        properties: {
          secret: { type: "string" }
        },
        required: ["secret"]
      },
      enumerable: false
    });
    const manifest = buildManifest(
      {
        servers: {
          fake: { transport: "stdio", command: "node" }
        }
      },
      [
        {
          serverId: "fake",
          tools: [
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: {
                  safe: { type: "string" }
                },
                oneOf,
                additionalProperties: false
              } as unknown as TackManifest["tools"][string]["inputSchema"]
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const types = await readFile(join(tmpPath, "types.ts"), "utf8");
    expect(types).toContain("safe?: string;");
    expect(types).not.toContain("secret");
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("prunes cyclic JSON Schema back-references at the discovery boundary", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-cyclic-schema-"));
    const inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {}
    };
    inputSchema["properties"] = {
      self: inputSchema
    };
    const manifest = buildManifest(
      {
        servers: {
          fake: { transport: "stdio", command: "node" }
        }
      },
      [
        {
          serverId: "fake",
          tools: [
            {
              name: "echo",
              inputSchema: inputSchema as TackManifest["tools"][string]["inputSchema"]
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    // buildManifest sanitizes discovery data: the self-reference is dropped, so
    // the schema is finite and the SDK generates cleanly without it.
    expect(manifest.tools["fake.echo"]?.inputSchema).toEqual({ type: "object", properties: {} });
    await generateSdkPromise({ manifest, outDir: tmpPath });
    expect(await readFile(join(tmpPath, "index.ts"), "utf8")).toContain("createFakeClient");
  });

  it("ignores TypeScript-only schema extensions in discovered schemas", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-ts-extensions-"));
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
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: {
                  custom: {
                    type: "string",
                    tsType: "NotDeclared"
                  },
                  mode: {
                    type: "string",
                    enum: ["a", "b"],
                    tsEnumNames: ["A", "B"]
                  }
                },
                additionalProperties: false
              },
              outputSchema: {
                type: "object",
                properties: {
                  result: {
                    tsType: "AlsoNotDeclared"
                  }
                },
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const types = await readFile(join(tmpPath, "types.ts"), "utf8");
    expect(types).not.toContain("NotDeclared");
    expect(types).not.toContain("AlsoNotDeclared");
    expect(types).not.toContain("const enum");
    expect(types).toContain('mode?: "a" | "b";');
    await writeFile(join(tmpPath, "ts-extensions.generated.ts"), [
      'import type { FakeEchoInput, FakeEchoOutput } from "./index.js";',
      "",
      "const input: FakeEchoInput = {",
      "  custom: \"value\",",
      "  mode: \"a\"",
      "};",
      "const output: FakeEchoOutput = {};",
      "",
      "void input;",
      "void output;",
      ""
    ].join("\n"), "utf8");
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("preserves literal schema data that contains ref-looking keys", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-literal-ref-data-"));
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
            {
              name: "echo",
              inputSchema: {
                type: "object",
                definitions: {
                  Foo: {
                    type: "object",
                    properties: {
                      value: { type: "string" }
                    },
                    required: ["value"],
                    additionalProperties: false
                  }
                },
                properties: {
                  data: { $ref: "#/definitions/Foo" },
                  literal: {
                    enum: [{ $ref: "#/definitions/Foo", keep: true }]
                  },
                  exact: {
                    const: { $ref: "#/definitions/Foo", keep: true }
                  },
                  nested: {
                    enum: [[{ $ref: "#/definitions/Foo" }]]
                  }
                },
                required: ["data", "literal", "exact", "nested"],
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });
    await writeFile(join(tmpPath, "literal-ref.generated.ts"), [
      'import type { FakeEchoInput } from "./index.js";',
      "",
      "const input: FakeEchoInput = {",
      "  data: { value: \"ok\" },",
      "  literal: { $ref: \"#/definitions/Foo\", keep: true },",
      "  exact: { $ref: \"#/definitions/Foo\", keep: true },",
      "  nested: [{ $ref: \"#/definitions/Foo\" }]",
      "};",
      "",
      "void input;",
      ""
    ].join("\n"), "utf8");

    const types = await readFile(join(tmpPath, "types.ts"), "utf8");
    expect(types).toContain("$ref: \"#/definitions/Foo\";");
    expect(types).not.toContain("properties: {value: {type: \"string\"}}");
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("rejects external schema refs before the schema compiler can dereference them", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-external-ref-"));
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
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: {
                  remote: { $ref: "http://127.0.0.1:9/schema.json" },
                  file: { $ref: "file:///etc/hosts" },
                  relative: { $ref: "../other-schema.json#/Thing" },
                  literal: {
                    enum: [{ $ref: "http://127.0.0.1:9/data.json", keep: true }]
                  }
                },
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await expect(generateSdkPromise({ manifest, outDir: tmpPath }))
      .rejects
      .toThrow("External JSON Schema refs are not supported in generated SDK types: http://127.0.0.1:9/schema.json");
    await expect(readFile(join(tmpPath, "index.ts"), "utf8")).rejects.toThrow();
  });

  it("keeps generated SDK output stable across discovery timestamps", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-stable-timestamp-"));
    const outDirA = join(tmpPath, "a");
    const outDirB = join(tmpPath, "b");
    const config: TackConfig = {
      servers: {
        fake: { transport: "stdio", command: "node" }
      }
    };
    const discovered = [
      {
        serverId: "fake",
        tools: [
          {
            name: "echo",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false
            }
          }
        ]
      }
    ];
    const manifestA = buildManifest(config, discovered, new Date("2026-07-23T00:00:00.000Z"));
    const manifestB = buildManifest(config, discovered, new Date("2026-07-24T00:00:00.000Z"));

    await generateSdkPromise({ manifest: manifestA, outDir: outDirA });
    await generateSdkPromise({ manifest: manifestB, outDir: outDirB });

    expect(await readFile(join(outDirB, "index.ts"), "utf8"))
      .toBe(await readFile(join(outDirA, "index.ts"), "utf8"));
    expect(await readFile(join(outDirA, "index.ts"), "utf8"))
      .toContain("1970-01-01T00:00:00.000Z");
  });

  it("emits valid TypeScript identifiers for numeric-leading server names", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-numeric-"));
    const config: TackConfig = {
      servers: {
        "2fa": { transport: "stdio", command: "node" }
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId: "2fa",
          tools: [
            {
              name: "verify",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const index = await readFile(join(tmpPath, "index.ts"), "utf8");
    const server = await readFile(join(tmpPath, "_2fa.ts"), "utf8");
    const types = await readFile(join(tmpPath, "types.ts"), "utf8");
    expect(index).toContain('from "./_2fa.js"');
    expect(index).toContain('readonly "_2fa": _2FaClient;');
    expect(server).toContain("export interface _2FaClient");
    expect(types).toContain("export interface _2FaVerifyInput");
    expect(types).not.toContain("export interface 2Fa");
  });

  it("emits collision-safe server namespaces including reserved client names", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-server-collision-"));
    const config: TackConfig = {
      servers: {
        "foo-bar": { transport: "stdio", command: "node" },
        foo_bar: { transport: "stdio", command: "node" },
        close: { transport: "stdio", command: "node" }
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId: "close",
          tools: [
            {
              name: "echo",
              description: "SDK_SECRET_DESCRIPTION",
              inputSchema: {
                type: "object",
                properties: {
                  SDK_SECRET_SCHEMA: { type: "string" }
                },
                additionalProperties: false
              }
            }
          ]
        },
        {
          serverId: "foo_bar",
          tools: [
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        },
        {
          serverId: "foo-bar",
          tools: [
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const index = await readFile(join(tmpPath, "index.ts"), "utf8");
    const close2 = await readFile(join(tmpPath, "close2.ts"), "utf8");
    const fooBar = await readFile(join(tmpPath, "fooBar.ts"), "utf8");
    const fooBar2 = await readFile(join(tmpPath, "fooBar2.ts"), "utf8");
    const types = await readFile(join(tmpPath, "types.ts"), "utf8");
    expect(index).toContain('readonly "close2": Close2Client;');
    expect(index).toContain('readonly "fooBar": FooBarClient;');
    expect(index).toContain('readonly "fooBar2": FooBar2Client;');
    expect(index).toContain("close(): Promise<void>;");
    expect(close2).toContain('clientRuntime.invoke<Close2EchoOutput>("close.echo", ownDataRecord(args ?? {}))');
    expect(fooBar).toContain('clientRuntime.invoke<FooBarEchoOutput>("foo-bar.echo", ownDataRecord(args ?? {}))');
    expect(fooBar2).toContain('clientRuntime.invoke<FooBar2EchoOutput>("foo_bar.echo", ownDataRecord(args ?? {}))');
    expect(types).toContain("export interface Close2EchoInput");
    expect(types).toContain("export interface FooBarEchoInput");
    expect(types).toContain("export interface FooBar2EchoInput");
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("does not let server namespaces overwrite generated support files", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-support-file-collision-"));
    const config: TackConfig = {
      servers: {
        index: { transport: "stdio", command: "node" },
        types: { transport: "stdio", command: "node" }
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId: "index",
          tools: [
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        },
        {
          serverId: "types",
          tools: [
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const index = await readFile(join(tmpPath, "index.ts"), "utf8");
    const types = await readFile(join(tmpPath, "types.ts"), "utf8");
    const index2 = await readFile(join(tmpPath, "index2.ts"), "utf8");
    const types2 = await readFile(join(tmpPath, "types2.ts"), "utf8");
    expect(index).toContain('from "./index2.js"');
    expect(index).toContain('from "./types2.js"');
    expect(index).toContain('readonly "index2": Index2Client;');
    expect(index).toContain('readonly "types2": Types2Client;');
    expect(types).toContain("export interface Index2EchoInput");
    expect(types).toContain("export interface Types2EchoInput");
    expect(index2).toContain('clientRuntime.invoke<Index2EchoOutput>("index.echo", ownDataRecord(args ?? {}))');
    expect(types2).toContain('clientRuntime.invoke<Types2EchoOutput>("types.echo", ownDataRecord(args ?? {}))');
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("does not let server namespaces collide with root SDK exports", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-root-export-collision-"));
    const config: TackConfig = {
      servers: {
        tack: { transport: "stdio", command: "node" }
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId: "tack",
          tools: [
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const index = await readFile(join(tmpPath, "index.ts"), "utf8");
    const tack2 = await readFile(join(tmpPath, "tack2.ts"), "utf8");
    const types = await readFile(join(tmpPath, "types.ts"), "utf8");
    expect(index).toContain('from "./tack2.js"');
    expect(index).toContain('export { createTack2Client } from "./tack2.js";');
    expect(index).toContain('export type { Tack2Client } from "./tack2.js";');
    expect(index).toContain('readonly "tack2": Tack2Client;');
    expect(index).not.toContain('type TackClient } from "./tack.js"');
    expect(index).not.toContain('export { createTackClient } from "./tack.js";');
    expect(tack2).toContain("export interface Tack2Client");
    expect(tack2).toContain("export function createTack2Client");
    expect(tack2).toContain('clientRuntime.invoke<Tack2EchoOutput>("tack.echo", ownDataRecord(args ?? {}))');
    expect(types).toContain("export interface Tack2EchoInput");
    await expect(readFile(join(tmpPath, "tack.ts"), "utf8")).rejects.toThrow();
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("does not emit Windows-reserved generated SDK file names", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-windows-reserved-"));
    const config: TackConfig = {
      servers: {
        con: { transport: "stdio", command: "node" },
        aux: { transport: "stdio", command: "node" },
        com1: { transport: "stdio", command: "node" }
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId: "con",
          tools: [{ name: "echo", inputSchema: { type: "object", additionalProperties: false } }]
        },
        {
          serverId: "aux",
          tools: [{ name: "echo", inputSchema: { type: "object", additionalProperties: false } }]
        },
        {
          serverId: "com1",
          tools: [{ name: "echo", inputSchema: { type: "object", additionalProperties: false } }]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const index = await readFile(join(tmpPath, "index.ts"), "utf8");
    const con2 = await readFile(join(tmpPath, "con2.ts"), "utf8");
    const aux2 = await readFile(join(tmpPath, "aux2.ts"), "utf8");
    const com12 = await readFile(join(tmpPath, "com12.ts"), "utf8");
    expect(index).toContain('from "./con2.js"');
    expect(index).toContain('from "./aux2.js"');
    expect(index).toContain('from "./com12.js"');
    expect(con2).toContain('clientRuntime.invoke<Con2EchoOutput>("con.echo", ownDataRecord(args ?? {}))');
    expect(aux2).toContain('clientRuntime.invoke<Aux2EchoOutput>("aux.echo", ownDataRecord(args ?? {}))');
    expect(com12).toContain('clientRuntime.invoke<Com12EchoOutput>("com1.echo", ownDataRecord(args ?? {}))');
    await expect(readFile(join(tmpPath, "con.ts"), "utf8")).rejects.toThrow();
    await expect(readFile(join(tmpPath, "aux.ts"), "utf8")).rejects.toThrow();
    await expect(readFile(join(tmpPath, "com1.ts"), "utf8")).rejects.toThrow();
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("rejects unsafe direct-manifest server module names before writing SDK files", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-unsafe-server-name-"));
    const manifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {},
      tools: {
        "escape.echo": {
          id: "escape.echo",
          serverId: "escape",
          namespaceName: "../escape",
          sdkName: "echo",
          upstreamName: "echo",
          inputSchema: {
            type: "object",
            additionalProperties: false
          }
        },
        "index.echo": {
          id: "index.echo",
          serverId: "index",
          namespaceName: "index",
          sdkName: "echo",
          upstreamName: "echo",
          inputSchema: {
            type: "object",
            additionalProperties: false
          }
        }
      }
    };

    await expect(generateSdkPromise({ manifest, outDir: tmpPath }))
      .rejects
      .toThrow("Unsafe generated SDK server module name");
    await expect(readFile(join(tmpPath, "index.ts"), "utf8")).rejects.toThrow();
    await expect(readFile(join(tmpPath, "types.ts"), "utf8")).rejects.toThrow();
    await expect(readFile(join(tmpPath, "../escape.ts"), "utf8")).rejects.toThrow();
  });

  it("rejects unsupported or malformed direct manifest inputs before writing SDK files", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-invalid-manifest-"));
    await expect(generateSdkPromise({
      manifest: null as unknown as TackManifest,
      outDir: join(tmpPath, "null")
    }))
      .rejects
      .toThrow("Invalid Tack manifest: manifest must be an object");
    await expect(readFile(join(tmpPath, "null", "index.ts"), "utf8")).rejects.toThrow();

    const unsupportedVersionManifest = {
      version: "0.2",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {},
      tools: {}
    } as unknown as TackManifest;

    await expect(generateSdkPromise({ manifest: unsupportedVersionManifest, outDir: tmpPath }))
      .rejects
      .toThrow("Unsupported Tack manifest version: 0.2");
    await expect(readFile(join(tmpPath, "index.ts"), "utf8")).rejects.toThrow();

    const malformedServersManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: [],
      tools: {}
    } as unknown as TackManifest;

    await expect(generateSdkPromise({
      manifest: malformedServersManifest,
      outDir: join(tmpPath, "malformed-servers")
    }))
      .rejects
      .toThrow("Invalid Tack manifest: servers must be an object");
    await expect(readFile(join(tmpPath, "malformed-servers", "index.ts"), "utf8")).rejects.toThrow();

    const malformedToolsManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {},
      tools: null
    } as unknown as TackManifest;

    await expect(generateSdkPromise({
      manifest: malformedToolsManifest,
      outDir: join(tmpPath, "malformed")
    }))
      .rejects
      .toThrow("Invalid Tack manifest: tools must be an object");
    await expect(readFile(join(tmpPath, "malformed", "index.ts"), "utf8")).rejects.toThrow();

    const malformedToolEntryManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {},
      tools: {
        "fake.echo": null
      }
    } as unknown as TackManifest;

    await expect(generateSdkPromise({
      manifest: malformedToolEntryManifest,
      outDir: join(tmpPath, "malformed-tool")
    }))
      .rejects
      .toThrow("Invalid Tack manifest tool entry fake.echo: tool must be an object");
    await expect(readFile(join(tmpPath, "malformed-tool", "index.ts"), "utf8")).rejects.toThrow();
  });

  it("rejects direct manifests whose visible tools are missing server coverage", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-missing-server-"));
    const missingServerManifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {},
      tools: {
        "fake.echo": {
          id: "fake.echo",
          serverId: "fake",
          namespaceName: "fake",
          sdkName: "echo",
          upstreamName: "echo",
          inputSchema: {
            type: "object",
            additionalProperties: false
          }
        }
      }
    };

    await expect(generateSdkPromise({ manifest: missingServerManifest, outDir: tmpPath }))
      .rejects
      .toThrow("references missing manifest server fake");
    await expect(readFile(join(tmpPath, "index.ts"), "utf8")).rejects.toThrow();

    const staleServerManifest: TackManifest = {
      ...missingServerManifest,
      servers: {
        fake: {
          id: "fake",
          transport: "stdio",
          tools: []
        }
      }
    };

    await expect(generateSdkPromise({
      manifest: staleServerManifest,
      outDir: join(tmpPath, "stale")
    }))
      .rejects
      .toThrow("is not listed by manifest server fake");
    await expect(readFile(join(tmpPath, "stale", "index.ts"), "utf8")).rejects.toThrow();
  });

  it("rejects direct manifests with accessor server coverage without invoking getters", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-server-accessor-"));
    const server = {
      id: "fake",
      transport: "stdio" as const,
      get tools() {
        throw new Error("server tools getter should not run");
      }
    } as unknown as TackManifest["servers"][string];
    const manifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        fake: server
      },
      tools: {
        "fake.echo": {
          id: "fake.echo",
          serverId: "fake",
          namespaceName: "fake",
          sdkName: "echo",
          upstreamName: "echo",
          inputSchema: {
            type: "object",
            additionalProperties: false
          }
        }
      }
    };

    await expect(generateSdkPromise({ manifest, outDir: tmpPath }))
      .rejects
      .toThrow("Generated SDK server fake has invalid manifest metadata");
    await expect(readFile(join(tmpPath, "index.ts"), "utf8")).rejects.toThrow();
  });

  it("uses own data manifest server tool ids when generating runtime manifests", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-server-tool-array-"));
    const tools: string[] = [];
    Object.defineProperty(tools, "0", {
      enumerable: true,
      get() {
        throw new Error("server tool id getter should not run");
      }
    });
    Object.defineProperty(tools, "1", {
      enumerable: true,
      value: "fake.echo"
    });
    const manifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        fake: {
          id: "fake",
          transport: "stdio",
          tools
        }
      },
      tools: {
        "fake.echo": {
          id: "fake.echo",
          serverId: "fake",
          namespaceName: "fake",
          sdkName: "echo",
          upstreamName: "echo",
          inputSchema: {
            type: "object",
            additionalProperties: false
          }
        }
      }
    };

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const index = await readFile(join(tmpPath, "index.ts"), "utf8");
    expect(index).toContain('\\"tools\\":[\\"fake.echo\\"]');
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("rejects direct manifests whose visible tool keys do not match tool ids", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-mismatched-tool-id-"));
    const manifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        fake: {
          id: "fake",
          transport: "stdio",
          tools: ["fake.echo"]
        }
      },
      tools: {
        "fake.duplicate": {
          id: "fake.echo",
          serverId: "fake",
          namespaceName: "fake",
          sdkName: "echo",
          upstreamName: "echo",
          inputSchema: {
            type: "object",
            additionalProperties: false
          }
        }
      }
    };

    await expect(generateSdkPromise({ manifest, outDir: tmpPath }))
      .rejects
      .toThrow("Visible manifest tool entry fake.duplicate has mismatched id fake.echo");
    await expect(readFile(join(tmpPath, "index.ts"), "utf8")).rejects.toThrow();
  });

  it("rejects direct manifests whose visible tools cannot be planned", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-unplannable-tool-"));
    const missingOwnMetadataTool = Object.assign(
      Object.create({
        serverId: "fake",
        namespaceName: "fake",
        sdkName: "echo",
        upstreamName: "echo"
      }),
      {
        id: "fake.echo",
        inputSchema: {
          type: "object"
        }
      }
    );
    const manifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        fake: {
          id: "fake",
          transport: "stdio",
          tools: ["fake.echo"]
        }
      },
      tools: {
        "fake.echo": missingOwnMetadataTool
      }
    };

    await expect(generateSdkPromise({ manifest, outDir: tmpPath }))
      .rejects
      .toThrow("Visible manifest tool entry fake.echo has invalid SDK metadata");
    await expect(readFile(join(tmpPath, "index.ts"), "utf8")).rejects.toThrow();

    await expect(generateSdkPromise({
      manifest: {
        ...manifest,
        tools: {
          "fake.echo": {
            id: "fake.echo",
            serverId: "fake",
            namespaceName: "fake",
            sdkName: "echo",
            upstreamName: "echo",
            inputSchema: null
          } as unknown as TackManifest["tools"][string]
        }
      },
      outDir: join(tmpPath, "bad-schema")
    }))
      .rejects
      .toThrow("Visible manifest tool entry fake.echo has invalid SDK metadata");
    await expect(readFile(join(tmpPath, "bad-schema", "index.ts"), "utf8")).rejects.toThrow();
  });

  it("rejects direct manifests with accessor tool metadata without invoking getters", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-tool-accessor-"));
    const tool = {
      id: "fake.echo",
      get serverId() {
        throw new Error("tool serverId getter should not run");
      },
      namespaceName: "fake",
      sdkName: "echo",
      upstreamName: "echo",
      inputSchema: {
        type: "object",
        additionalProperties: false
      }
    } as unknown as TackManifest["tools"][string];
    const manifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        fake: {
          id: "fake",
          transport: "stdio",
          tools: ["fake.echo"]
        }
      },
      tools: {
        "fake.echo": tool
      }
    };

    await expect(generateSdkPromise({ manifest, outDir: tmpPath }))
      .rejects
      .toThrow("Visible manifest tool entry fake.echo has invalid SDK metadata");
    await expect(readFile(join(tmpPath, "index.ts"), "utf8")).rejects.toThrow();
  });

  it("does not embed connection secrets in generated source", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-secrets-"));
    const config: TackConfig = {
      servers: {
        local: {
          transport: "stdio",
          command: "node",
          args: ["SDK_SECRET_ARG"],
          env: { TOKEN: "SDK_SECRET_ENV" },
          cwd: "/tmp/SDK_SECRET_CWD"
        },
        remote: {
          transport: "http",
          url: "https://SDK_SECRET_URL.example.com/mcp",
          headers: { authorization: "Bearer SDK_SECRET_HEADER" }
        }
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId: "local",
          tools: [
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        },
        {
          serverId: "remote",
          tools: [
            {
              name: "search",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const index = await readFile(join(tmpPath, "index.ts"), "utf8");
    expect(index).toContain('\\"local.echo\\"');
    expect(index).toContain('\\"remote.search\\"');
    expect(index).not.toContain("SDK_SECRET_ARG");
    expect(index).not.toContain("SDK_SECRET_ENV");
    expect(index).not.toContain("SDK_SECRET_CWD");
    expect(index).not.toContain("SDK_SECRET_URL");
    expect(index).not.toContain("SDK_SECRET_HEADER");
    expect(index).not.toContain("SDK_SECRET_DESCRIPTION");
    expect(index).not.toContain("SDK_SECRET_SCHEMA");
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("includes all discovered tools in the generated runtime manifest", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-secret-tools-"));
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
            {
              name: "visible",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            },
            {
              name: "secret_tool",
              description: "SDK_SECRET_TOOL_DESCRIPTION",
              inputSchema: {
                type: "object",
                properties: {
                  SDK_SECRET_TOOL_SCHEMA: { type: "string" }
                },
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const index = await readFile(join(tmpPath, "index.ts"), "utf8");
    const fake = await readFile(join(tmpPath, "fake.ts"), "utf8");
    const types = await readFile(join(tmpPath, "types.ts"), "utf8");
    expect(index).toContain('\\"fake.visible\\"');
    expect(index).toContain('\\"fake.secret_tool\\"');
    expect(index).not.toContain("SDK_SECRET_TOOL_SCHEMA");
    expect(fake).toContain('"visible"(args?: FakeVisibleInput)');
    expect(fake).toContain('"secretTool"(args?: FakeSecretToolInput)');
    expect(types).toContain("export interface FakeVisibleInput");
    expect(types).toContain("export interface FakeSecretToolInput");
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("generates a compilable SDK when a server has one discovered tool", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-one-tool-"));
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
            {
              name: "secret_tool",
              description: "SDK_SECRET_TOOL_DESCRIPTION",
              inputSchema: {
                type: "object",
                properties: {
                  SDK_SECRET_TOOL_SCHEMA: { type: "string" }
                },
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const index = await readFile(join(tmpPath, "index.ts"), "utf8");
    const types = await readFile(join(tmpPath, "types.ts"), "utf8");
    expect(index).toContain("export interface TackClient");
    expect(index).toContain("close(): Promise<void>;");
    expect(index).toContain('readonly "fake":');
    expect(index).toContain("secret_tool");
    expect(types).toContain("SecretTool");
    expect(await readFile(join(tmpPath, "fake.ts"), "utf8")).toContain('"secretTool"');
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("preserves prototype-looking manifest keys as JSON data", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-proto-key-"));
    const serverId = "__proto__";
    const config: TackConfig = {
      servers: {
        [serverId]: { transport: "stdio", command: "node" }
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId,
          tools: [
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const index = await readFile(join(tmpPath, "index.ts"), "utf8");
    expect(index).toContain("const manifest = JSON.parse(");
    expect(index).toContain("\\\"servers\\\":{\\\"__proto__\\\"");
    expect(index).toContain("\\\"__proto__\\\"");
    expect(index).not.toContain("const manifest = {");
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("compiles generated SDK paths containing reserved JavaScript words", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-reserved-words-"));
    const config: TackConfig = {
      servers: {
        class: { transport: "stdio", command: "node" }
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId: "class",
          tools: [
            {
              name: "delete",
              inputSchema: {
                type: "object",
                properties: {
                  value: { type: "string" }
                },
                required: ["value"],
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const index = await readFile(join(tmpPath, "index.ts"), "utf8");
    const server = await readFile(join(tmpPath, "class.ts"), "utf8");
    expect(index).toContain('readonly "class": ClassClient;');
    expect(server).toContain('"delete"(args: ClassDeleteInput)');
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("compiles generated SDK paths containing prototype-sensitive names", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-prototype-names-"));
    const config: TackConfig = {
      servers: {
        constructor: { transport: "stdio", command: "node" }
      }
    };
    const manifest = buildManifest(
      config,
      [
        {
          serverId: "constructor",
          tools: [
            {
              name: "make",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const index = await readFile(join(tmpPath, "index.ts"), "utf8");
    const server = await readFile(join(tmpPath, "constructor.ts"), "utf8");
    expect(index).toContain('readonly "constructor": ConstructorClient;');
    expect(server).toContain('"make"(args?: ConstructorMakeInput)');
    await writeFile(join(tmpPath, "prototype.generated.ts"), [
      'import { createTackClientFromRuntime } from "./index.js";',
      'import type { TackRuntime } from "@tack/core";',
      "",
      "const runtime: TackRuntime = {",
      "  invoke: async () => ({",
      "    raw: {},",
      "    isError: false,",
      "    structuredContent: undefined,",
      "    text: () => \"\",",
      "    json: <T>() => ({}) as T",
      "  }),",
      "  close: async () => {}",
      "};",
      "",
    "async function run(): Promise<void> {",
    "  const client = createTackClientFromRuntime(runtime);",
      "  await client.constructor.make();",
      "}",
      "",
      "void run();",
      ""
    ].join("\n"), "utf8");
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("compiles generated SDK types from symbol-only path and schema definition names", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-symbol-type-names-"));
    const manifest: TackManifest = {
      version: "0.1",
      generatedAt: "2026-07-23T00:00:00.000Z",
      servers: {
        fake: {
          id: "fake",
          transport: "stdio",
          tools: ["fake.echo"]
        }
      },
      tools: {
        "fake.echo": {
          id: "fake.echo",
          serverId: "fake",
          namespaceName: "fake",
          sdkName: "!!!",
          upstreamName: "echo",
          inputSchema: {
            type: "object",
            properties: {
              value: { $ref: "#/$defs/🔥" }
            },
            required: ["value"],
            additionalProperties: false,
            $defs: {
              "🔥": {
                type: "string"
              }
            }
          }
        }
      }
    };

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const server = await readFile(join(tmpPath, "fake.ts"), "utf8");
    const types = await readFile(join(tmpPath, "types.ts"), "utf8");
    expect(server).toContain('"tool"(args: FakeToolInput)');
    expect(types).toContain("export interface FakeToolInput");
    expect(types).toContain("FakeToolInput_Item");
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("cleans stale Tack-generated TypeScript files without deleting user files", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-clean-"));
    await writeFile(
      join(tmpPath, "stale.ts"),
      "/* Generated by Tack. Do not edit directly. */\nexport const stale = true;\n",
      "utf8"
    );
    await writeFile(join(tmpPath, "user.ts"), "export const user = true;\n", "utf8");

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
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    await expect(readFile(join(tmpPath, "stale.ts"), "utf8")).rejects.toThrow();
    expect(await readFile(join(tmpPath, "user.ts"), "utf8")).toContain("user = true");
    expect(await readFile(join(tmpPath, "fake.ts"), "utf8")).toContain('"echo"(args?: FakeEchoInput)');
  });

  it("keeps the previous generated SDK when new output fails to render", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-failed-render-"));
    const staleContents = "/* Generated by Tack. Do not edit directly. */\nexport const oldSdk = true;\n";
    await writeFile(join(tmpPath, "stale.ts"), staleContents, "utf8");
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
            {
              name: "bad_schema",
              inputSchema: {
                type: "object",
                allOf: 1
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await expect(generateSdkPromise({ manifest, outDir: tmpPath }))
      .rejects
      .toThrow("Failed to generate Tack SDK");
    expect(await readFile(join(tmpPath, "stale.ts"), "utf8")).toBe(staleContents);
  });

  it("keeps the previous generated SDK when an output path is blocked", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-blocked-output-"));
    const staleContents = "/* Generated by Tack. Do not edit directly. */\nexport const oldSdk = true;\n";
    await writeFile(join(tmpPath, "stale.ts"), staleContents, "utf8");
    await mkdir(join(tmpPath, "fake.ts"));

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
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await expect(generateSdkPromise({ manifest, outDir: tmpPath }))
      .rejects
      .toThrow("target path is not a file");
    expect(await readFile(join(tmpPath, "stale.ts"), "utf8")).toBe(staleContents);
  });

  it("refuses to overwrite non-generated SDK target files", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-user-target-"));
    const staleContents = "/* Generated by Tack. Do not edit directly. */\nexport const oldSdk = true;\n";
    const userIndex = "export const userOwnedIndex = true;\n";
    await writeFile(join(tmpPath, "stale.ts"), staleContents, "utf8");
    await writeFile(join(tmpPath, "index.ts"), userIndex, "utf8");

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
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await expect(generateSdkPromise({ manifest, outDir: tmpPath }))
      .rejects
      .toThrow("Refusing to overwrite non-generated SDK file index.ts");
    expect(await readFile(join(tmpPath, "stale.ts"), "utf8")).toBe(staleContents);
    expect(await readFile(join(tmpPath, "index.ts"), "utf8")).toBe(userIndex);
    await expect(readFile(join(tmpPath, "fake.ts"), "utf8")).rejects.toThrow();
  });

  it("generates collision-safe SDK paths where one operation prefixes another", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-generator-prefix-collision-"));
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
            {
              name: "foo",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            },
            {
              name: "foo_bar",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            },
            {
              name: "foo_bar_baz",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const fake = await readFile(join(tmpPath, "fake.ts"), "utf8");
    const types = await readFile(join(tmpPath, "types.ts"), "utf8");
    expect(fake).toContain('"foo"(args?: FakeFooInput)');
    expect(fake).toContain('"fooBar"(args?: FakeFooBarInput)');
    expect(fake).toContain('"fooBarBaz"(args?: FakeFooBarBazInput)');
    expect(types).toContain("export interface FakeFooInput");
    expect(types).toContain("export interface FakeFooBarInput");
    expect(types).toContain("export interface FakeFooBarBazInput");
    await expectGeneratedSdkToCompile(tmpPath);
  });

  it("generates ergonomic Grafana-inferred SDK paths", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-grafana-generator-"));
    const config: TackConfig = {
      servers: {
        grafana: { transport: "stdio", command: "uvx", args: ["mcp-grafana"] }
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
              description: "Manage Grafana alert rules.",
              inputSchema: {
                type: "object",
                properties: {
                  operation: {
                    type: "string",
                    enum: ["list", "get", "create"]
                  },
                  rule_uid: { type: "string" }
                },
                required: ["operation"],
                additionalProperties: false
              }
            },
            {
              name: "search_dashboards",
              description: "Search for Grafana dashboards.",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                additionalProperties: false
              }
            },
            {
              name: "get_dashboard_summary",
              description: "Get a compact dashboard summary.",
              inputSchema: {
                type: "object",
                properties: { uid: { type: "string" } },
                required: ["uid"],
                additionalProperties: false
              }
            },
            {
              name: "list_datasources",
              description: "List all configured datasources.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
              }
            }
          ]
        }
      ],
      new Date("2026-07-23T00:00:00.000Z")
    );

    await generateSdkPromise({ manifest, outDir: tmpPath });

    const index = await readFile(join(tmpPath, "index.ts"), "utf8");
    const grafana = await readFile(join(tmpPath, "grafana.ts"), "utf8");
    const types = await readFile(join(tmpPath, "types.ts"), "utf8");

    expect(index).toContain('from "./grafana.js"');
    expect(index).not.toContain("GrafanaAlertingRulesListInput");
    expect(grafana).toContain('readonly "alerting":');
    expect(grafana).toContain('readonly "rules":');
    expect(grafana).toContain('"list"(args?: GrafanaAlertingRulesListInput)');
    expect(grafana).toContain('"get"(args?: GrafanaAlertingRulesGetInput)');
    expect(grafana).toContain('"create"(args?: GrafanaAlertingRulesCreateInput)');
    expect(grafana).toContain('readonly "dashboards":');
    expect(grafana).toContain('"search"(args?: GrafanaDashboardsSearchInput)');
    expect(grafana).toContain('"getSummary"(args: GrafanaDashboardsGetSummaryInput)');
    expect(grafana).toContain('readonly "datasources":');
    expect(grafana).toContain('"list"(args?: GrafanaDatasourcesListInput)');
    expect(grafana).toContain("Search for Grafana dashboards.");
    expect(grafana).toContain("  GrafanaAlertingRulesListInput,");
    expect(grafana).toContain("  GrafanaDashboardsSearchInput,");
    expect(grafana).toContain("GrafanaAlertingRulesListOutput,");
    expect(grafana).toContain('clientRuntime.invoke<GrafanaAlertingRulesListOutput>("grafana.alerting_manage_rules", withInjectedArgs(args ?? {}, { "operation": "list" }))');
    expect(types).toContain("export interface GrafanaAlertingRulesListInput");
    expect(types).not.toContain("operation:");
  });
});

async function expectGeneratedSdkToCompile(outDir: string): Promise<void> {
  const tsconfigPath = join(outDir, "tsconfig.generated.json");
  await writeFile(tsconfigPath, JSON.stringify({
    extends: join(repoRoot, "tsconfig.base.json"),
    compilerOptions: {
      noEmit: true,
      typeRoots: [join(repoRoot, "node_modules", "@types")],
      paths: {
        "@tack/core": [relative(outDir, join(repoRoot, "packages", "core", "src", "index.ts"))],
        "@tack/mcp": [relative(outDir, join(repoRoot, "packages", "mcp", "src", "index.ts"))],
        "@tack/sources": [relative(outDir, join(repoRoot, "packages", "sources", "src", "index.ts"))]
      }
    },
    include: [join(outDir, "*.ts")]
  }, null, 2), "utf8");

  const tsc = spawnSync(join(repoRoot, "node_modules", ".bin", "tsc"), [
    "-p",
    tsconfigPath
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  expect(tsc.stderr).toBe("");
  expect(tsc.stdout).toBe("");
  expect(tsc.status).toBe(0);
}
