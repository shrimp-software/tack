import { describe, expect, it } from "vitest";
import { fakeRuntime, grafanaManifest } from "../../core/test/fixtures.js";

import {
  createExecutionEngine,
  createExecuteDescription,
  createTackToolInvoker,
  describeTool,
  findGuide,
  formatTraceLine,
  isOperationAllowed,
  isTackRef,
  normalizeDescribeToolInput,
  normalizeSearchInput,
  searchOperations,
  type CodeRuntime,
  type OperationPolicy
} from "../src/index.js";
import { listOperations, type TackManifest } from "@tack/core";

describe("codemode operation helpers", () => {
  it("renders short execute descriptions and long execute guide docs from the manifest", () => {
    const manifest = grafanaManifest();
    const description = createExecuteDescription(manifest);

    expect(description).toContain("Run TypeScript in Tack's sandboxed runtime.");
    expect(description).toContain('guide({ name: "execute" })');
    expect(description).toContain("## Available namespaces");
    expect(description).toContain("- `grafana`");
    expect(description).not.toContain("## Workflow");

    const guide = findGuide("execute", manifest);
    expect(guide?.body).toContain("## Workflow");
    expect(guide?.body).toContain("tools.describe.tool");
    expect(guide?.body).toContain("ToolFile shape");
    expect(guide?.body).toContain("emitted text files are truncated at 64000 chars");
    expect(guide?.body).toContain("- `grafana`");
    expect(findGuide("missing", manifest)).toBeUndefined();
  });

  it("searches and describes inferred operations from the shared graph", async () => {
    const manifest = grafanaManifest();
    const search = searchOperations(manifest, { query: "list rules" });

    expect(search.items[0]).toMatchObject({
      path: "grafana.alerting.rules.list",
      namespace: "grafana",
      serverId: "grafana",
      example: "await tools.grafana.alerting.rules.list()",
      score: expect.any(Number),
      matchedTokens: ["list", "rules"]
    });
    expect(search.items[0]).not.toHaveProperty("inputSchema");
    expect(search.items[0]).not.toHaveProperty("outputSchema");

    const described = await describeTool(manifest, {
      path: "grafana.alerting.rules.list"
    });
    expect(described).toMatchObject({
      path: "grafana.alerting.rules.list",
      injectedArgs: { operation: "list" },
      examples: ["await tools.grafana.alerting.rules.list()"]
    });
    expect("inputTypeScript" in described && described.inputTypeScript).toContain("rule_uid");
  });

  it("searches with inferred paths, fuzzy matches, schema terms, and namespace filters", () => {
    const manifest = grafanaManifest();

    expect(searchOperations(manifest, { query: "datasource" }).items[0]).toMatchObject({
      path: "grafana.datasources.list"
    });
    expect(searchOperations(manifest, { query: "datasorce" }).items[0]).toMatchObject({
      path: "grafana.datasources.list"
    });
    expect(searchOperations(manifest, { query: "unique identifier" }).items[0]).toMatchObject({
      path: "grafana.alerting.rules.get"
    });
    expect(searchOperations(manifest, {
      query: "list",
      namespace: "grafana"
    }).items.every((item) => item.path.startsWith("grafana."))).toBe(true);
    expect(searchOperations(manifest, { query: "" })).toEqual({
      items: [],
      total: 0,
      hasMore: false,
      nextOffset: null
    });
    const enumerated = searchOperations(manifest, { query: "", namespace: "grafana" });
    expect(enumerated.total).toBe(3);
    expect(enumerated.items[0]).toMatchObject({
      path: "grafana.alerting.rules.get",
      namespace: "grafana",
      score: 0,
      matchedTokens: []
    });
    expect(searchOperations(manifest, { query: "datasources list" }).items.map((item) => item.path)).toEqual([
      "grafana.datasources.list"
    ]);
  });

  it("normalizes search and describe inputs without invoking getters", () => {
    const searchInput = {};
    Object.defineProperty(searchInput, "query", {
      enumerable: true,
      get() {
        throw new Error("search query getter should not run");
      }
    });
    const describeInput = {};
    Object.defineProperty(describeInput, "path", {
      enumerable: true,
      get() {
        throw new Error("describe path getter should not run");
      }
    });

    expect(normalizeSearchInput(searchInput)).toEqual({ query: "" });
    expect(normalizeDescribeToolInput(describeInput)).toEqual({ path: "" });
  });

  it("searches schema terms without invoking schema getters", () => {
    const manifest = grafanaManifest();
    const tool = manifest.tools["grafana.list_datasources"];
    if (!tool) {
      throw new Error("missing fixture tool");
    }
    const inputSchema = {
      type: "object",
      properties: {
        safe_query: { type: "string" }
      }
    };
    Object.defineProperty(inputSchema, "description", {
      enumerable: true,
      get() {
        throw new Error("schema description getter should not run");
      }
    });
    const poisonedManifest: TackManifest = {
      ...manifest,
      tools: {
        ...manifest.tools,
        "grafana.list_datasources": {
          ...tool,
          inputSchema
        }
      }
    };

    expect(searchOperations(poisonedManifest, { query: "safe query" }).items[0]).toMatchObject({
      path: "grafana.datasources.list"
    });
  });

  it("applies policies without invoking getters or recursing forever", () => {
    const operation = listOperations(grafanaManifest())[0];
    if (!operation) {
      throw new Error("missing fixture operation");
    }
    const accessorPolicy = {};
    Object.defineProperty(accessorPolicy, "deniedOperations", {
      enumerable: true,
      get() {
        throw new Error("deniedOperations getter should not run");
      }
    });
    const cyclicPolicy: OperationPolicy = {
      allowedOperations: ["grafana.*"]
    };
    (cyclicPolicy as { allOf?: OperationPolicy[] }).allOf = [cyclicPolicy];

    expect(isOperationAllowed(operation, accessorPolicy as OperationPolicy)).toEqual({ allowed: true });
    expect(isOperationAllowed(operation, cyclicPolicy)).toEqual({ allowed: true });
  });

  it("routes built-ins and inferred tool calls through one invoker", async () => {
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const invoker = createTackToolInvoker({
      manifest: grafanaManifest(),
      runtime: fakeRuntime(calls)
    });

    const search = await invoker.invoke({
      path: "search",
      args: { query: "datasources" }
    });
    expect(search).toMatchObject({
      items: [expect.objectContaining({
        path: "grafana.datasources.list",
        namespace: "grafana"
      })]
    });

    const result = await invoker.invoke({
      path: "grafana.alerting.rules.get",
      args: { rule_uid: "abc" }
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        toolId: "grafana.alerting_manage_rules",
        args: { rule_uid: "abc", operation: "get" }
      }
    });
  });

  it("invokes without reading accessor call input fields", async () => {
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const invoker = createTackToolInvoker({
      manifest: grafanaManifest(),
      runtime: fakeRuntime(calls)
    });
    const poisonedPathCall = {};
    Object.defineProperty(poisonedPathCall, "path", {
      enumerable: true,
      get() {
        throw new Error("call path getter should not run");
      }
    });
    const poisonedArgsCall = {
      path: "grafana.alerting.rules.get"
    };
    Object.defineProperty(poisonedArgsCall, "args", {
      enumerable: true,
      get() {
        throw new Error("call args getter should not run");
      }
    });

    await expect(invoker.invoke(poisonedPathCall as Parameters<typeof invoker.invoke>[0]))
      .resolves
      .toMatchObject({
        ok: false,
        error: { message: "Unknown Tack operation: " }
      });
    await expect(invoker.invoke(poisonedArgsCall as Parameters<typeof invoker.invoke>[0]))
      .resolves
      .toMatchObject({
        ok: true
      });
    expect(calls).toEqual([
      {
        toolId: "grafana.alerting_manage_rules",
        args: { operation: "get" }
      }
    ]);
  });

  it("invokes without reading live option fields after creation", async () => {
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const traces: unknown[] = [];
    const audits: unknown[] = [];
    const options = {
      manifest: grafanaManifest(),
      runtime: fakeRuntime(calls),
      executionId: "exec-1",
      onTraceEvent: (event: unknown) => {
        traces.push(event);
      },
      onAuditEvent: (event: unknown) => {
        audits.push(event);
      }
    };
    const invoker = createTackToolInvoker(options);
    for (const key of ["manifest", "runtime", "policy", "executionId", "onTraceEvent", "onAuditEvent"] as const) {
      Object.defineProperty(options, key, {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error(`${key} getter should not run`);
        }
      });
    }

    const search = await invoker.invoke({
      path: "search",
      args: { query: "datasources" }
    });
    const executed = await invoker.invoke({
      path: "grafana.datasources.list",
      args: {}
    });

    expect(search).toMatchObject({
      items: [expect.objectContaining({ path: "grafana.datasources.list" })]
    });
    expect(executed).toMatchObject({
      ok: true,
      data: { toolId: "grafana.list_datasources" }
    });
    expect(calls).toEqual([{ toolId: "grafana.list_datasources", args: {} }]);
    expect(traces).toEqual([
      expect.objectContaining({ type: "builtin_call", path: "search", ok: true }),
      expect.objectContaining({
        type: "tool_call_start",
        executionId: "exec-1",
        path: "grafana.datasources.list"
      }),
      expect.objectContaining({
        type: "tool_call",
        executionId: "exec-1",
        path: "grafana.datasources.list",
        ok: true
      })
    ]);
    expect(audits).toEqual([
      expect.objectContaining({
        executionId: "exec-1",
        path: "grafana.datasources.list",
        ok: true
      })
    ]);
  });

  it("returns built-in failures through the success channel", async () => {
    const traces: unknown[] = [];
    const manifest = grafanaManifest();
    const brokenTool = manifest.tools["grafana.list_datasources"];
    if (!brokenTool) {
      throw new Error("missing fixture tool");
    }
    const invoker = createTackToolInvoker({
      manifest: {
        ...manifest,
        tools: {
          ...manifest.tools,
          "grafana.list_datasources": {
            ...brokenTool,
            inputSchema: {
              type: "object",
              allOf: 1
            }
          }
        }
      },
      runtime: fakeRuntime([]),
      onTraceEvent: (event) => {
        traces.push(event);
      }
    });

    const result = await invoker.invoke({
      path: "describe.tool",
      args: { path: "grafana.datasources.list" }
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        message: expect.any(String)
      }
    });
    expect(traces).toEqual([
      expect.objectContaining({
        type: "builtin_call",
        path: "describe.tool",
        ok: false,
        error: expect.any(String)
      })
    ]);
  });

  it("describes tool schemas without invoking schema getters", async () => {
    const manifest = grafanaManifest();
    const tool = manifest.tools["grafana.list_datasources"];
    if (!tool) {
      throw new Error("missing fixture tool");
    }
    const inputSchema = {
      type: "object",
      properties: {
        safe_query: { type: "string" }
      }
    };
    Object.defineProperty(inputSchema, "description", {
      enumerable: true,
      get() {
        throw new Error("schema description getter should not run");
      }
    });
    const poisonedManifest: TackManifest = {
      ...manifest,
      tools: {
        ...manifest.tools,
        "grafana.list_datasources": {
          ...tool,
          inputSchema
        }
      }
    };

    const described = await describeTool(poisonedManifest, {
      path: "grafana.datasources.list"
    });

    expect("inputTypeScript" in described && described.inputTypeScript).toContain("safe_query");
  });

  it("describes tool schemas without non-enumerable schema array branches", async () => {
    const manifest = grafanaManifest();
    const tool = manifest.tools["grafana.list_datasources"];
    if (!tool) {
      throw new Error("missing fixture tool");
    }
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
    const poisonedManifest: TackManifest = {
      ...manifest,
      tools: {
        ...manifest.tools,
        "grafana.list_datasources": {
          ...tool,
          inputSchema: {
            type: "object",
            properties: {
              safe_query: { type: "string" }
            },
            oneOf,
            additionalProperties: false
          }
        }
      }
    };

    const described = await describeTool(poisonedManifest, {
      path: "grafana.datasources.list"
    });

    expect("inputTypeScript" in described && described.inputTypeScript).toContain("safe_query");
    expect("inputTypeScript" in described && described.inputTypeScript).not.toContain("secret");
  });

  it("describes tool schemas without TypeScript-only schema extensions", async () => {
    const manifest = grafanaManifest();
    const tool = manifest.tools["grafana.list_datasources"];
    if (!tool) {
      throw new Error("missing fixture tool");
    }
    const poisonedManifest: TackManifest = {
      ...manifest,
      tools: {
        ...manifest.tools,
        "grafana.list_datasources": {
          ...tool,
          inputSchema: {
            $id: "InjectedInputName",
            title: "TitleInjectedInputName",
            description: "schema prose",
            type: "object",
            properties: {
              unsafe: {
                tsType: "NotDeclared",
                type: "string"
              },
              mode: {
                type: "string",
                enum: ["a", "b"],
                tsEnumNames: ["A", "B"]
              }
            },
            additionalProperties: false
          }
        }
      }
    };

    const described = await describeTool(poisonedManifest, {
      path: "grafana.datasources.list"
    });

    if (!("inputTypeScript" in described)) {
      throw new Error("expected described tool");
    }
    expect(described.inputTypeScript).toContain("unsafe?: string;");
    expect(described.inputTypeScript).toContain('mode?: "a" | "b";');
    expect(described.inputTypeScript).not.toContain("NotDeclared");
    expect(described.inputTypeScript).not.toContain("InjectedInputName");
    expect(described.inputTypeScript).not.toContain("schema prose");
  });

  it("rejects external schema refs when describing tool types", async () => {
    const manifest = grafanaManifest();
    const tool = manifest.tools["grafana.list_datasources"];
    if (!tool) {
      throw new Error("missing fixture tool");
    }
    const poisonedManifest: TackManifest = {
      ...manifest,
      tools: {
        ...manifest.tools,
        "grafana.list_datasources": {
          ...tool,
          inputSchema: {
            $ref: "https://example.com/schema.json"
          }
        }
      }
    };

    await expect(describeTool(poisonedManifest, {
      path: "grafana.datasources.list"
    })).rejects.toThrow("External JSON Schema refs are not supported in described tool types");
  });

  it("creates execution engines without invoking optional option accessors", async () => {
    const options = {
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime: {
        name: "test",
        isolation: "none",
        execute: async () => ({
          ok: true,
          result: "ok",
          emitted: [],
          logs: []
        })
      } satisfies CodeRuntime
    };
    Object.defineProperty(options, "policy", {
      enumerable: true,
      get() {
        throw new Error("policy getter should not run");
      }
    });
    Object.defineProperty(options, "onAuditEvent", {
      enumerable: true,
      get() {
        throw new Error("audit getter should not run");
      }
    });

    const result = await createExecutionEngine(options).execute("return 'ok';");

    expect(result).toMatchObject({
      ok: true,
      result: "ok",
      trace: {
        runtime: "test",
        isolation: "none"
      }
    });
  });

  it("executes without reading live code runtime fields after creation", async () => {
    const codeRuntime = {
      name: "test",
      isolation: "none",
      execute: async () => ({
        ok: true,
        result: "ok",
        emitted: [],
        logs: []
      })
    } satisfies CodeRuntime;
    const engine = createExecutionEngine({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime
    });
    for (const key of ["name", "isolation", "execute"] as const) {
      Object.defineProperty(codeRuntime, key, {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error(`${key} getter should not run`);
        }
      });
    }

    const result = await engine.execute("return 'ok';");

    expect(result).toMatchObject({
      ok: true,
      result: "ok",
      trace: {
        runtime: "test",
        isolation: "none"
      }
    });
  });

  it("correlates execution results and tool-call audit events", async () => {
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const audits: Array<{ executionId?: string }> = [];
    const codeRuntime: CodeRuntime = {
      name: "test",
      isolation: "none",
      execute: async ({ invoker }) => {
        await invoker.invoke({
          path: "search",
          args: { query: "datasources" }
        });
        await invoker.invoke({
          path: "describe.tool",
          args: { path: "grafana.datasources.list" }
        });
        return {
          ok: true,
          result: await invoker.invoke({
            path: "grafana.datasources.list",
            args: {}
          }),
          emitted: [],
          logs: []
        };
      }
    };
    const engine = createExecutionEngine({
      manifest: grafanaManifest(),
      runtime: fakeRuntime(calls),
      codeRuntime,
      onAuditEvent: (event) => {
        audits.push(event);
      }
    });
    expect(engine.getDescription()).toContain("## Available namespaces");

    const result = await engine.execute("return tools.grafana.datasources.list();");

    expect(result.executionId).toEqual(expect.any(String));
    expect(result.trace).toMatchObject({
      runtime: "test",
      isolation: "none",
      toolCalls: 1,
      deniedToolCalls: 0,
      failedToolCalls: 0,
      builtinCalls: [
        expect.objectContaining({ type: "builtin_call", path: "search", ok: true }),
        expect.objectContaining({ type: "builtin_call", path: "describe.tool", ok: true })
      ],
      operations: [
        expect.objectContaining({
          executionId: result.executionId,
          path: "grafana.datasources.list",
          toolId: "grafana.list_datasources",
          allowed: true,
          ok: true
        })
      ]
    });
    expect(audits).toEqual([
      expect.objectContaining({
        executionId: result.executionId,
        path: "grafana.datasources.list",
        ok: true
      })
    ]);
  });

  it("applies operation policy before search, describe, and MCP invocation", async () => {
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const audits: unknown[] = [];
    const invoker = createTackToolInvoker({
      manifest: grafanaManifest(),
      runtime: fakeRuntime(calls),
      policy: {
        allowedOperations: ["grafana.datasources.*"],
        deniedOperations: ["grafana.alerting.*"]
      },
      onAuditEvent: (event) => {
        audits.push(event);
      }
    });

    const search = await invoker.invoke({
      path: "search",
      args: { query: "list" }
    });
    expect(search).toMatchObject({
      items: [expect.objectContaining({ path: "grafana.datasources.list" })]
    });

    const described = await invoker.invoke({
      path: "describe.tool",
      args: { path: "grafana.alerting.rules.list" }
    });
    expect(described).toMatchObject({
      error: { code: "tool_not_found" }
    });

    const denied = await invoker.invoke({
      path: "grafana.alerting.rules.list",
      args: {}
    });
    expect(denied).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining("denied by policy")
      }
    });

    const allowed = await invoker.invoke({
      path: "grafana.datasources.list",
      args: {}
    });
    expect(allowed).toMatchObject({
      ok: true
    });
    expect(calls).toEqual([{ toolId: "grafana.list_datasources", args: {} }]);
    expect(audits).toEqual([
      expect.objectContaining({
        type: "tool_call",
        path: "grafana.alerting.rules.list",
        toolId: "grafana.alerting_manage_rules",
        allowed: false,
        ok: false
      }),
      expect.objectContaining({
        type: "tool_call",
        path: "grafana.datasources.list",
        toolId: "grafana.list_datasources",
        allowed: true,
        ok: true
      })
    ]);
  });
});

describe("isTackRef", () => {
  it("recognizes a ref marker and nothing else", () => {
    expect(isTackRef({ __tackRef: "$1", type: "Array(9)", preview: [] })).toBe(true);
    expect(isTackRef({ __tackRef: 1 })).toBe(false);
    expect(isTackRef({ ref: "$1" })).toBe(false);
    expect(isTackRef([])).toBe(false);
    expect(isTackRef(null)).toBe(false);
  });
});

describe("formatTraceLine", () => {
  it("renders start, success, denied and error events", () => {
    expect(formatTraceLine({
      type: "tool_call_start",
      timestamp: "t",
      path: "github.issues.list"
    })).toBe("→ github.issues.list");

    expect(formatTraceLine({
      type: "tool_call",
      timestamp: "t",
      path: "github.issues.list",
      allowed: true,
      ok: true,
      durationMs: 120
    })).toBe("← github.issues.list ok (120ms)");

    expect(formatTraceLine({
      type: "tool_call",
      timestamp: "t",
      path: "github.admin.reset",
      allowed: false,
      ok: false,
      error: "denied by policy"
    })).toBe("✗ github.admin.reset denied: denied by policy");

    expect(formatTraceLine({
      type: "tool_call",
      timestamp: "t",
      path: "github.issues.get",
      allowed: true,
      ok: false,
      error: "not found",
      durationMs: 40
    })).toBe("← github.issues.get error: not found (40ms)");

    expect(formatTraceLine({
      type: "builtin_call",
      path: "search",
      ok: true,
      durationMs: 3
    })).toBe("← search ok (3ms)");
  });
});

describe("execution engine live trace", () => {
  it("forwards every event to onTrace as the code runs", async () => {
    const seen: string[] = [];
    const codeRuntime: CodeRuntime = {
      name: "test",
      isolation: "none",
      execute: async (input) => {
        await input.invoker.invoke({ path: "grafana.datasources.list", args: {} });
        return { ok: true, result: "done", emitted: [], logs: [] };
      }
    };
    const engine = createExecutionEngine({
      manifest: grafanaManifest(),
      runtime: fakeRuntime([]),
      codeRuntime,
      onTrace: (event) => {
        seen.push(formatTraceLine(event));
      }
    });

    const result = await engine.execute("noop");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.ok).toBe(true);
    expect(seen).toEqual([
      "→ grafana.datasources.list",
      expect.stringMatching(/^← grafana\.datasources\.list ok/)
    ]);
  });
});
