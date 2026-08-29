import { describe, expect, it } from "vitest";

import { ownField, sanitizeData } from "../src/index.js";

const opts = { onCycle: "cycle" } as const;

describe("sanitizeData", () => {
  it("keeps only own enumerable data properties", () => {
    const source = Object.create({ inherited: "nope" }) as Record<string, unknown>;
    Object.defineProperty(source, "visible", { enumerable: true, value: 1 });
    Object.defineProperty(source, "nonEnumerable", { enumerable: false, value: 2 });
    Object.defineProperty(source, "computed", {
      enumerable: true,
      get: () => {
        throw new Error("accessor should not run");
      }
    });

    const clean = sanitizeData(source, opts) as Record<string, unknown>;

    expect(clean).toEqual({ visible: 1 });
    expect(Object.getPrototypeOf(clean)).toBeNull();
    expect("inherited" in clean).toBe(false);
  });

  it("drops own keys whose value is undefined", () => {
    const source = { keep: 1 } as Record<string, unknown>;
    Object.defineProperty(source, "gone", { enumerable: true, value: undefined });

    expect(sanitizeData(source, opts)).toEqual({ keep: 1 });
    expect(Object.keys(sanitizeData(source, opts) as object)).toEqual(["keep"]);
  });

  it("preserves a literal __proto__ key as ordinary data without polluting a prototype", () => {
    const source = {} as Record<string, unknown>;
    Object.defineProperty(source, "__proto__", { enumerable: true, value: "data", configurable: true });

    const clean = sanitizeData(source, opts) as Record<string, unknown>;

    expect(Object.keys(clean)).toEqual(["__proto__"]);
    expect(clean["__proto__"]).toBe("data");
    expect(Object.getPrototypeOf(clean)).toBeNull();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();

    const roundTripped = JSON.parse(JSON.stringify(clean)) as Record<string, unknown>;
    expect(Object.hasOwn(roundTripped, "__proto__")).toBe(true);
    expect(roundTripped["__proto__"]).toBe("data");
  });

  it("deep-copies nested objects and arrays", () => {
    const source = { a: { b: [1, { c: 2 }] } };
    const clean = sanitizeData(source, opts) as typeof source;

    expect(clean).toEqual(source);
    expect(clean.a).not.toBe(source.a);
    expect(clean.a.b).not.toBe(source.a.b);
    expect(Object.getPrototypeOf(clean.a)).toBeNull();
  });

  it("compacts getter / non-enumerable / hole array slots out", () => {
    const arr: unknown[] = ["safe"];
    Object.defineProperty(arr, "1", {
      enumerable: true,
      get: () => {
        throw new Error("array getter should not run");
      }
    });
    Object.defineProperty(arr, "2", { enumerable: false, value: "hidden" });
    arr.length = 4; // index 3 is a hole
    arr.push("tail");

    expect(sanitizeData(arr, opts)).toEqual(["safe", "tail"]);
  });

  it("throws onCycle for reference cycles when a message is given", () => {
    const source: Record<string, unknown> = {};
    source["self"] = source;

    expect(() => sanitizeData(source, opts)).toThrow("cycle");
  });

  it("breaks the cycle silently when onCycle is omitted", () => {
    const source: Record<string, unknown> = { keep: 1 };
    source["self"] = source;

    expect(sanitizeData(source, {})).toEqual({ keep: 1 });
  });

  it("rejects non-data values by default and stringifies them on request", () => {
    expect(() => sanitizeData({ n: 1n }, opts)).toThrow(/bigint/);
    expect(() => sanitizeData({ f: () => 0 }, opts)).toThrow(/function/);

    expect(sanitizeData({ n: 10n, f: () => 0 }, { onCycle: "cycle", nonData: "stringify" })).toEqual({
      n: "10",
      f: expect.stringContaining("=>")
    });
  });

  it("passes primitives through", () => {
    expect(sanitizeData("x", opts)).toBe("x");
    expect(sanitizeData(3, opts)).toBe(3);
    expect(sanitizeData(null, opts)).toBeNull();
    expect(sanitizeData(undefined, opts)).toBeUndefined();
  });
});

describe("ownField", () => {
  it("reads own data properties and ignores accessors and inheritance", () => {
    const source = Object.create({ inherited: "nope" }) as Record<string, unknown>;
    Object.defineProperty(source, "visible", { enumerable: true, value: 1 });
    Object.defineProperty(source, "hidden", { enumerable: false, value: 2 });
    Object.defineProperty(source, "computed", {
      enumerable: true,
      get: () => {
        throw new Error("accessor should not run");
      }
    });

    expect(ownField(source, "visible")).toBe(1);
    expect(ownField(source, "hidden")).toBe(2);
    expect(ownField(source, "computed")).toBeUndefined();
    expect(ownField(source, "inherited")).toBeUndefined();
    expect(ownField("not an object", "x")).toBeUndefined();
    expect(ownField(null, "x")).toBeUndefined();
  });

  it("does not deep-copy — the reference is returned as-is", () => {
    const fn = (): number => 1;
    expect(ownField({ fn }, "fn")).toBe(fn);
  });
});
