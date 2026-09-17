import { inspect } from "node:util";
import { expect, it, vi } from "vitest";
import { isSafeToolProxySegment } from "@cbxss/tack-core";
import { createTools } from "../src/tools.js";

it("shares reflection-sensitive segment rules with the generated live interface", async () => {
  const invoke = vi.fn(async () => ({ ok: true as const, data: null, dataShape: null, upstreamOutcome: "succeeded" as const, responseId: null }));
  const tools = createTools(invoke);
  const namespace = tools["local"]!;
  for (const key of ["then", "toJSON", "prototype", "__proto__", "constructor", "toString", "name", "length", "call", "apply", "bind", "arguments", "caller"]) {
    expect(isSafeToolProxySegment(key)).toBe(false);
    expect(Reflect.get(tools, key)).toBeUndefined();
    expect(Reflect.get(namespace, key)).toBeUndefined();
  }
  expect(await namespace).toBe(namespace);
  expect(JSON.stringify(namespace)).toBeUndefined();
  expect(inspect(namespace)).toBeTypeOf("string");
  expect(String(namespace)).toBe("[Tack tools.local]");
  expect(Reflect.get(namespace, Symbol.iterator)).toBeUndefined();
  expect(invoke).not.toHaveBeenCalled();
  expect(isSafeToolProxySegment("search")).toBe(true);
  await namespace["search"]!({ query: "fixture" });
  expect(invoke).toHaveBeenCalledWith("local.search", { query: "fixture" }, undefined);
});
