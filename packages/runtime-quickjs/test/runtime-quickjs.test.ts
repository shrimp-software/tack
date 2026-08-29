import { describe, expect, it } from "vitest";

import { renderToolsPrelude, type ToolInvoker } from "@tack/codemode";
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
      message: expect.stringContaining("Tool bridge response exceeded")
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

describe("quickjs session", () => {
  it("persists top-level declarations across exec cells", async () => {
    const runtime = createQuickJSRuntime({ timeoutMs: 5_000 });
    const session = await runtime.createSession!();
    try {
      const first = await session.exec({
        code: "const nums = [1, 2, 3];\nfunction total(list) { return list.reduce((a, b) => a + b, 0); }\nlet acc = 10;",
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude()
      });
      expect(first.ok).toBe(true);

      const second = await session.exec({
        code: "return total(nums) + acc;",
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude()
      });
      expect(second).toMatchObject({ ok: true, result: 16 });
    } finally {
      await session.close();
    }
  });

  it("keeps emitted/logs per cell and rejects after close", async () => {
    const runtime = createQuickJSRuntime({ timeoutMs: 5_000 });
    const session = await runtime.createSession!();

    const a = await session.exec({
      code: "console.log('a'); emit(1); const x = 1;",
      invoker: fakeInvoker([]),
      toolsPrelude: renderToolsPrelude()
    });
    expect(a.emitted).toEqual([1]);
    expect(a.logs).toEqual(["[log] a"]);

    const b = await session.exec({
      code: "return x + 1;",
      invoker: fakeInvoker([]),
      toolsPrelude: renderToolsPrelude()
    });
    expect(b).toMatchObject({ ok: true, result: 2 });
    expect(b.emitted).toEqual([]);
    expect(b.logs).toEqual([]);

    await session.close();
    const afterClose = await session.exec({
      code: "return 1;",
      invoker: fakeInvoker([]),
      toolsPrelude: renderToolsPrelude()
    });
    expect(afterClose).toMatchObject({ ok: false, error: { message: "Session is closed" } });
  });

  it("persists reassignments across cells unless the cell returns first", async () => {
    const runtime = createQuickJSRuntime({ timeoutMs: 5_000 });
    const session = await runtime.createSession!();
    try {
      await session.exec({
        code: "let count = 0;\nlet kept = 1;",
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude()
      });
      await session.exec({
        code: "count += 5;\nkept += 10;",
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude()
      });
      const seen = await session.exec({
        code: "return { count, kept };",
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude()
      });
      expect(seen).toMatchObject({ ok: true, result: { count: 5, kept: 11 } });

      // a cell that returns before finishing does not persist its own reassignment
      await session.exec({
        code: "count = 999;\nreturn count;",
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude()
      });
      const after = await session.exec({
        code: "return count;",
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude()
      });
      expect(after).toMatchObject({ ok: true, result: 5 });
    } finally {
      await session.close();
    }
  });

  it("close() waits for an in-flight cell instead of disposing under it", async () => {
    const runtime = createQuickJSRuntime({ timeoutMs: 5_000 });
    const session = await runtime.createSession!();

    const slowInvoker: ToolInvoker = {
      invoke: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, data: 1, text: "1" }), 40))
    };

    const cell = session.exec({
      code: "const x = await tools.call('demo.echo', {}); return x.data;",
      invoker: slowInvoker,
      toolsPrelude: renderToolsPrelude()
    });
    await session.close();
    const result = await cell;
    expect(result.ok).toBe(true);
    expect(result.result).toBe(1);

    const afterClose = await session.exec({
      code: "return 1;",
      invoker: fakeInvoker([]),
      toolsPrelude: renderToolsPrelude()
    });
    expect(afterClose).toMatchObject({ ok: false, error: { message: "Session is closed" } });
  });

  it("retains a large return value as a ref and dereferences it", async () => {
    const runtime = createQuickJSRuntime({ timeoutMs: 5_000, maxInlineResultBytes: 200 });
    const session = await runtime.createSession!();
    try {
      const big = await session.exec({
        code: "return Array.from({ length: 500 }, (_, i) => ({ id: i, name: 'row-' + i }));",
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude()
      });
      expect(big.ok).toBe(true);
      expect(big.result).toMatchObject({ __tackRef: "$1", type: expect.stringContaining("Array(500)") });
      const preview = (big.result as { preview: unknown[] }).preview;
      expect(Array.isArray(preview)).toBe(true);
      expect(preview.length).toBeLessThanOrEqual(10);

      // the ref is usable as a bare identifier in the next cell
      const usesRef = await session.exec({
        code: "return $1.length + ($_ === $1 ? 1 : 0);",
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude()
      });
      expect(usesRef).toMatchObject({ ok: true, result: 501 });

      // deref pages the retained value
      const page = await session.deref!("$1", { offset: 0, limit: 3 });
      expect(page).toMatchObject({
        ok: true,
        truncated: true,
        value: [{ id: 0, name: "row-0" }, { id: 1 }, { id: 2 }]
      });

      const missing = await session.deref!("$nope");
      expect(missing.ok).toBe(false);

      // a small value still returns inline
      const small = await session.exec({
        code: "return { hi: true };",
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude()
      });
      expect(small).toMatchObject({ ok: true, result: { hi: true } });
    } finally {
      await session.close();
    }
  });

  it("bounds the ref preview for a value wrapping a large nested array", async () => {
    const runtime = createQuickJSRuntime({ timeoutMs: 5_000, maxInlineResultBytes: 200 });
    const session = await runtime.createSession!();
    try {
      const wrapped = await session.exec({
        code: "return { ok: true, data: Array.from({ length: 300 }, (_, i) => ({ i, blob: 'y'.repeat(400) })) };",
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude()
      });
      const result = wrapped.result as { __tackRef: string; type: string; preview: { data: unknown[] } };
      expect(result.__tackRef).toBe("$1");
      expect(result.type).toContain("data: Array(300)");
      expect(result.preview.data.length).toBeLessThanOrEqual(10);
      expect(JSON.stringify(result.preview).length).toBeLessThan(4_000);

      // the full value is still intact behind the ref
      const full = await session.deref!("$1", { limit: 1000 });
      expect((full.value as { data: unknown[] }).data.length).toBe(300);
    } finally {
      await session.close();
    }
  });

  it("surfaces a failing cell without poisoning the session scope", async () => {
    const runtime = createQuickJSRuntime({ timeoutMs: 5_000 });
    const session = await runtime.createSession!();
    try {
      await session.exec({
        code: "const good = 42;",
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude()
      });
      const bad = await session.exec({
        code: "const boom = (() => { throw new Error('nope'); })();",
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude()
      });
      expect(bad).toMatchObject({ ok: false, error: { phase: "runtime" } });

      const recover = await session.exec({
        code: "return good;",
        invoker: fakeInvoker([]),
        toolsPrelude: renderToolsPrelude()
      });
      expect(recover).toMatchObject({ ok: true, result: 42 });
    } finally {
      await session.close();
    }
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
