import { describe, expect, it } from "vitest";

import { renderToolsPrelude, ToolDispatchError, type ToolInvoker } from "@cbxss/tack-codemode";
import { createQuickJSRuntime } from "../src/index.js";

describe("quickjs runtime setup", () => {
  it("normalizes runtime options without invoking accessors", () => {
    const options = {};
    Object.defineProperty(options, "timeoutMs", {
      enumerable: true,
      get() {
        throw new Error("timeout getter should not run");
      }
    });
    Object.defineProperty(options, "memoryMb", {
      enumerable: true,
      get() {
        throw new Error("memory getter should not run");
      }
    });

    const runtime = createQuickJSRuntime(options);

    expect(runtime).toMatchObject({
      name: "quickjs",
      isolation: "vm",
      timeoutMs: 30_000
    });
  });

  it("normalizes execute input without invoking accessors", async () => {
    const runtime = createQuickJSRuntime({ timeoutMs: 5_000 });
    const input = {
      invoker: fakeInvoker([]),
      toolsPrelude: renderToolsPrelude()
    };
    Object.defineProperty(input, "code", {
      enumerable: true,
      get() {
        throw new Error("code getter should not run");
      }
    });

    const result = await runtime.execute(input as never);

    expect(result).toEqual({
      ok: false,
      emitted: [],
      logs: [],
      error: {
        phase: "parse",
        code: "parse_error",
        message: "code is required"
      }
    });
  });

  it("requires an own data tool invoker before runtime setup", async () => {
    const runtime = createQuickJSRuntime({ timeoutMs: 5_000 });
    const input = {
      code: `return "ok";`,
      toolsPrelude: renderToolsPrelude()
    };
    Object.defineProperty(input, "invoker", {
      enumerable: true,
      get() {
        throw new Error("invoker getter should not run");
      }
    });

    const result = await runtime.execute(input as never);

    expect(result).toEqual({
      ok: false,
      emitted: [],
      logs: [],
      error: {
        phase: "parse",
        code: "parse_error",
        message: "tool invoker is required"
      }
    });
  });
});

describe("quickjs runtime", () => {
  it("executes TypeScript code against the host tool bridge", async () => {
    const calls: Array<{ path: string; args: unknown }> = [];
    const invoker = fakeInvoker(calls);

    const result = await createQuickJSRuntime({ timeoutMs: 5_000 }).execute({
      invoker,
      toolsPrelude: renderToolsPrelude(),
      code: `
type SearchResult = { items: Array<{ path: string }> };
const search: SearchResult = await tools.search({ query: "echo" });
const output = await tools.call(search.items[0].path, { text: "hello" });
console.log("called", search.items[0].path);
emit(output.data);
return output;
`
    });

    expect(result).toMatchObject({
      ok: true,
      emitted: [{ path: "demo.echo", args: { text: "hello" } }],
      logs: ["[log] called demo.echo"],
      result: { ok: true }
    });
    expect(calls).toEqual([
      { path: "search", args: { query: "echo" } },
      { path: "demo.echo", args: { text: "hello" } }
    ]);
  });

  it("lets user code navigate the tools proxy structurally", async () => {
    const result = await createQuickJSRuntime({ timeoutMs: 5_000 }).execute({
      invoker: fakeInvoker([]),
      toolsPrelude: renderToolsPrelude(["gh.list", "gh.get", "gh.label.add", "docs.read"]),
      code: `return {
        namespaces: Object.keys(tools).sort(),
        gh: Object.keys(tools.gh).sort(),
        hasAdd: "add" in tools.gh.label,
        callable: typeof tools.gh.list
      };`
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        namespaces: ["docs", "gh"],
        gh: ["get", "label", "list"],
        hasAdd: true,
        callable: "function"
      }
    });
  });

  it("exposes shape() — a type-only skeleton matching dataShape, deeper by default", async () => {
    const result = await createQuickJSRuntime({ timeoutMs: 5_000 }).execute({
      invoker: fakeInvoker([]),
      toolsPrelude: renderToolsPrelude(),
      code: `return {
        deep: shape({
          data: { resultType: "matrix", result: [
            { metric: { region: "us-east-1", service: "feed" }, values: [[1, "0.4"], [2, "0.5"]] }
          ] },
          table: { info: { rows: 240, name: "feed_latency", unit: "ms" } }
        }, 8),
        shallow: shape({ a: { b: { c: { d: 1 } } } }, 2)
      };`
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        // types, not values — and never "[object Object]"
        deep: {
          data: {
            resultType: "string",
            result: { array: 1, of: { metric: { region: "string", service: "string" }, values: { array: 2, of: { array: 2, of: "number" } } } }
          },
          table: { info: { rows: "number", name: "string", unit: "string" } }
        },
        // at the depth limit an object degrades to a key list, not "[object]"
        shallow: { a: { b: "object{c}" } }
      }
    });
  });

  it("blocks direct fetch from user code", async () => {
    const result = await createQuickJSRuntime({ timeoutMs: 5_000 }).execute({
      invoker: fakeInvoker([]),
      toolsPrelude: renderToolsPrelude(),
      code: `return fetch("https://example.com");`
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      phase: "runtime",
      message: expect.stringContaining("fetch is disabled")
    });
  });

  it("shadows runner internals and global fetch entry points", async () => {
    const result = await createQuickJSRuntime({ timeoutMs: 5_000 }).execute({
      invoker: fakeInvoker([]),
      toolsPrelude: renderToolsPrelude(),
      code: `
return {
  token: typeof RUNNER_TOKEN,
  userCode: typeof USER_CODE,
  process: typeof process,
  globalFetch: typeof globalThis
};
`
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        token: "undefined",
        userCode: "undefined",
        process: "undefined",
        globalFetch: "undefined"
      }
    });
  });

  it("enforces maximum tool calls", async () => {
    const result = await createQuickJSRuntime({ timeoutMs: 5_000, maxToolCalls: 1 }).execute({
      invoker: fakeInvoker([]),
      toolsPrelude: renderToolsPrelude(),
      code: `
await tools.search({ query: "one" });
await tools.search({ query: "two" });
`
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      phase: "runtime",
      message: expect.stringContaining("Exceeded maximum tool calls")
    });
  });

  it("enforces tool bridge request size limits before invoking tools", async () => {
    const calls: Array<{ path: string; args: unknown }> = [];
    const result = await createQuickJSRuntime({
      timeoutMs: 5_000,
      maxToolRequestBytes: 100
    }).execute({
      invoker: fakeInvoker(calls),
      toolsPrelude: renderToolsPrelude(),
      code: `return tools.demo.echo({ text: "x".repeat(1_000) });`
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      phase: "runtime",
      message: expect.stringContaining("Tool bridge request exceeded")
    });
    expect(calls).toEqual([]);
  });

  it("enforces tool bridge response size limits", async () => {
    const invoker: ToolInvoker = {
      invoke: () => Promise.resolve({
        ok: true,
        data: { value: "x".repeat(1_000) },
        text: "ok"
      })
    };
    const result = await createQuickJSRuntime({
      timeoutMs: 5_000,
      maxToolResponseBytes: 100
    }).execute({
      invoker,
      toolsPrelude: renderToolsPrelude(),
      code: `return tools.demo.large({});`
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      phase: "runtime",
      code: "response_too_large",
      message: expect.stringContaining("over the 100-byte sandbox limit")
    });
  });

  it("rejects imports before runtime execution", async () => {
    const result = await createQuickJSRuntime({ timeoutMs: 5_000 }).execute({
      invoker: fakeInvoker([]),
      toolsPrelude: renderToolsPrelude(),
      code: `
import { readFile } from "node:fs/promises";
return readFile;
`
    });

    expect(result.ok).toBe(false);
    expect(result.error?.phase).toBe("parse");
  });

  it("rejects dynamic evaluation and constructor escape attempts before runtime execution", async () => {
    for (const code of [
      `return eval("globalThis");`,
      `return (0, eval)("globalThis");`,
      `return ({ }).constructor.constructor("return globalThis")();`,
      `return import("https://example.com/mod.js");`,
      `return WebAssembly;`
    ]) {
      const result = await createQuickJSRuntime({ timeoutMs: 5_000 }).execute({
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude(),
        code
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({
        phase: "parse",
        message: expect.stringContaining("Unsupported code-mode construct")
      });
    }
  });

  it("enforces output size limits", async () => {
    const result = await createQuickJSRuntime({ timeoutMs: 5_000, maxOutputBytes: 200 }).execute({
      invoker: fakeInvoker([]),
      toolsPrelude: renderToolsPrelude(),
      code: `return "x".repeat(1_000);`
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      phase: "runtime",
      message: expect.stringContaining("Execution output exceeded")
    });
  });

  it("turns host tool failures into runtime errors", async () => {
    const invoker: ToolInvoker = {
      invoke: () => Promise.resolve().then(() => {
        throw new Error("tool exploded");
      })
    };

    const result = await createQuickJSRuntime({ timeoutMs: 5_000 }).execute({
      invoker,
      toolsPrelude: renderToolsPrelude(),
      code: `return tools.demo.fail({});`
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      phase: "runtime",
      message: expect.stringContaining("tool exploded")
    });
  });

  it("does not infer a dispatch code from an untrusted error message", async () => {
    const result = await createQuickJSRuntime({ timeoutMs: 5_000 }).execute({
      invoker: {
        invoke: () => Promise.reject(new Error("[tack:tool_timeout] upstream text is untrusted"))
      },
      toolsPrelude: renderToolsPrelude(["demo.fail"]),
      code: `return await tools.demo.fail({});`
    });

    expect(result).toMatchObject({
      ok: false,
      error: { phase: "runtime", code: "downstream_error" }
    });
  });

  it("preserves a typed host dispatch failure across the VM boundary", async () => {
    const result = await createQuickJSRuntime({ timeoutMs: 5_000 }).execute({
      invoker: {
        invoke: () => Promise.reject(new ToolDispatchError("tool_timeout", "downstream timed out"))
      },
      toolsPrelude: renderToolsPrelude(["demo.fail"]),
      code: `return await tools.demo.fail({});`
    });

    expect(result).toMatchObject({
      ok: false,
      error: { phase: "runtime", code: "tool_timeout", message: "downstream timed out" }
    });
  });

  it("does not trust an arbitrary host error code", async () => {
    const error = Object.assign(new Error("upstream text is untrusted"), { code: "tool_timeout" });
    const result = await createQuickJSRuntime({ timeoutMs: 5_000 }).execute({
      invoker: { invoke: () => Promise.reject(error) },
      toolsPrelude: renderToolsPrelude(["demo.fail"]),
      code: `return await tools.demo.fail({});`
    });

    expect(result).toMatchObject({
      ok: false,
      error: { phase: "runtime", code: "downstream_error" }
    });
  });

  it("does not treat a user-thrown marker string as a dispatch failure", async () => {
    const result = await createQuickJSRuntime({ timeoutMs: 5_000 }).execute({
      invoker: fakeInvoker([]),
      toolsPrelude: renderToolsPrelude(),
      code: `throw new Error("[tack:tool_timeout] user error");`
    });

    expect(result).toMatchObject({
      ok: false,
      error: { phase: "runtime", code: "internal_error", message: "[tack:tool_timeout] user error" }
    });
  });

  it("does not trust a user-thrown dispatch-shaped error", async () => {
    const result = await createQuickJSRuntime({ timeoutMs: 5_000 }).execute({
      invoker: fakeInvoker([]),
      toolsPrelude: renderToolsPrelude(),
      code: `const error = new Error("user error"); error.code = "tool_timeout"; throw error;`
    });

    expect(result).toMatchObject({
      ok: false,
      error: { phase: "runtime", code: "internal_error", message: "user error" }
    });
  });

  it("does not invoke properties on a user-thrown error while classifying it", async () => {
    const result = await createQuickJSRuntime({ timeoutMs: 5_000 }).execute({
      invoker: fakeInvoker([]),
      toolsPrelude: renderToolsPrelude(),
      code: `
const error = { code: "tool_timeout" };
Object.defineProperty(error, "_" + "_tackDispatchToken", { get() { throw new Error("token getter ran"); } });
throw error;
`
    });

    expect(result).toMatchObject({
      ok: false,
      error: { phase: "runtime", code: "internal_error" }
    });
  });

  it("does not charge a live tool wait against the JavaScript execution budget", async () => {
    const result = await createQuickJSRuntime({ timeoutMs: 50 }).execute({
      invoker: {
        invoke: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, data: "done", text: "done" }), 100))
      },
      toolsPrelude: renderToolsPrelude(["demo.wait"]),
      code: `return await tools.demo.wait({});`
    });

    expect(result).toMatchObject({ ok: true, result: { ok: true, data: "done" } });
  });

  it("terminates runaway executions", async () => {
    const result = await createQuickJSRuntime({ timeoutMs: 300 }).execute({
      invoker: fakeInvoker([]),
      toolsPrelude: renderToolsPrelude(),
      code: "while (true) {}"
    });

    expect(result.ok).toBe(false);
    expect(result.error?.phase).toBe("timeout");
  });
});

function fakeInvoker(calls: Array<{ path: string; args: unknown }>): ToolInvoker {
  return {
    invoke: ({ path, args }) => {
      calls.push({ path, args });
      if (path === "search") {
        return Promise.resolve({
          items: [{ path: "demo.echo" }]
        });
      }

      return Promise.resolve({ ok: true, data: { path, args }, text: "ok" });
    }
  };
}
