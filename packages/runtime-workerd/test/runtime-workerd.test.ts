import { describe, expect, it } from "vitest";

import { renderToolsPrelude, type ToolInvoker } from "@cbxss/tack-codemode";
import { createWorkerdRuntime, isWorkerdAvailable } from "../src/index.js";

const runIfWorkerd = isWorkerdAvailable() ? describe : describe.skip;

describe("workerd runtime setup", () => {
  it("normalizes runtime options without invoking accessors", () => {
    const options = {
      workerdBin: "/definitely/missing/tack-workerd"
    };
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

    const runtime = createWorkerdRuntime(options);

    expect(runtime.timeoutMs).toBe(30_000);
  });

  it("normalizes execute input without invoking accessors", async () => {
    const runtime = createWorkerdRuntime({
      timeoutMs: 5_000,
      workerdBin: "/definitely/missing/tack-workerd"
    });
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
        message: "code is required"
      }
    });
  });

  it("requires an own data tool invoker before runtime setup", async () => {
    const runtime = createWorkerdRuntime({
      timeoutMs: 5_000,
      workerdBin: "/definitely/missing/tack-workerd"
    });
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
        message: "tool invoker is required"
      }
    });
  });

  it("returns setup failures as execution results", async () => {
    const result = await createWorkerdRuntime({
        timeoutMs: 5_000,
        workerdBin: "/definitely/missing/tack-workerd"
      }).execute({
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude(),
        code: `return "ok";`
      });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      phase: "runtime",
      message: expect.stringContaining("Configured workerd binary does not exist")
    });
  });
});

runIfWorkerd("workerd runtime", () => {
  it("executes TypeScript code against the host tool bridge", async () => {
    const calls: Array<{ path: string; args: unknown }> = [];
    const invoker = fakeInvoker(calls);

    const result = await createWorkerdRuntime({ timeoutMs: 5_000 }).execute({
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

  it("blocks direct fetch from user code", async () => {
    const result = await createWorkerdRuntime({ timeoutMs: 5_000 }).execute({
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
    const result = await createWorkerdRuntime({ timeoutMs: 5_000 }).execute({
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
    const result = await createWorkerdRuntime({ timeoutMs: 5_000, maxToolCalls: 1 }).execute({
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
    const result = await createWorkerdRuntime({
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
    const result = await createWorkerdRuntime({
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
      message: expect.stringContaining("Tool bridge response exceeded")
    });
  });

  it("rejects imports before runtime execution", async () => {
    const result = await createWorkerdRuntime({ timeoutMs: 5_000 }).execute({
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
      const result = await createWorkerdRuntime({ timeoutMs: 5_000 }).execute({
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
    const result = await createWorkerdRuntime({ timeoutMs: 5_000, maxOutputBytes: 200 }).execute({
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

  it("starts with a configured V8 memory limit", async () => {
    const result = await createWorkerdRuntime({ timeoutMs: 5_000, memoryMb: 128 }).execute({
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude(),
        code: `return "ok";`
      });

    expect(result).toMatchObject({
      ok: true,
      result: "ok"
    });
  });

  it("turns host tool failures into runtime errors", async () => {
    const invoker: ToolInvoker = {
      invoke: () => Promise.resolve().then(() => {
        throw new Error("tool exploded");
      })
    };

    const result = await createWorkerdRuntime({ timeoutMs: 5_000 }).execute({
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

  it("terminates runaway executions", async () => {
    const result = await createWorkerdRuntime({
        timeoutMs: 300,
        hostTimeoutGraceMs: 100,
        startupTimeoutMs: 5_000
      }).execute({
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
