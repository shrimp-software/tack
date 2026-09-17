import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Tack, TackError, type TackConfig, type TackOptions } from "../src/index.js";
import { state } from "./fixtures/tools.js";

const fixtureDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const entry = join(fixtureDir, "tools.ts");
const clients: Tack[] = [];
const temporary: string[] = [];
function client(options: TackOptions = { config: { servers: { local: { transport: "module", entry } } } }): Tack {
  const tack = new Tack(options); clients.push(tack); return tack;
}
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tack-sdk-")); temporary.push(dir); return dir;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map(tack => tack.close()));
  await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("Tack module client", () => {
  it("preserves the class constructor, instanceof, and subclass behavior", async () => {
    class CustomTack extends Tack<{ config: TackConfig }> {}
    const tack: Tack = new CustomTack({ config: { servers: { local: { transport: "module", entry } } } });
    clients.push(tack);
    expect(Tack.name).toBe("Tack");
    expect(tack).toBeInstanceOf(Tack);
    expect(tack).toBeInstanceOf(CustomTack);
    expect(Object.getPrototypeOf(CustomTack.prototype)).toBe(Tack.prototype);
    await expect(tack.call("local.echo", { query: "subclass" })).resolves.toMatchObject({ data: { query: "subclass" } });
  });

  it("exposes lazy safe callable paths and never connects on reflection", async () => {
    const tack = client({ configPath: "/missing-sdk-config.json" });
    const namespace = tack.tools["local"]!;
    expect(tack.tools["local"]).toBe(namespace);
    expect(namespace["echo"]).toBe(namespace["echo"]);
    expect(await tack).toBe(tack);
    expect(await namespace).toBe(namespace);
    expect(await namespace["echo"]).toBe(namespace["echo"]);
    expect(JSON.stringify(tack)).toBe("{}");
    expect(JSON.stringify(namespace)).toBeUndefined();
    expect(inspect(namespace)).toContain("Function");
    expect(String(namespace)).toBe("[Tack tools.local]");
    expect(Object.getPrototypeOf(namespace)).toBeNull();
    expect(Object.keys(namespace)).toEqual([]);
    for (const key of ["then", "toJSON", "constructor", "__proto__", "prototype", "toString", "call", "bind", "name", "length"]) {
      expect(Reflect.get(namespace, key)).toBeUndefined();
    }
    expect(Reflect.get(namespace, Symbol.iterator)).toBeUndefined();
    expect(Reflect.set(namespace, "echo", () => undefined)).toBe(false);
    await tack.close();
    await expect(tack.ready()).rejects.toMatchObject({ code: "client_closed" });
  });

  it("calls the inferred dot path, preserves mismatched output and validates inputs", async () => {
    const tack = client();
    const before = state.calls;
    await expect(tack.tools["local"]!["echo"]!({ query: "select  *\n from logs" })).resolves.toMatchObject({
      ok: true, data: { query: "select  *\n from logs" }, responseId: null, upstreamOutcome: "succeeded"
    });
    await expect(tack.call("local.echo", {})).rejects.toMatchObject({ code: "input_validation_failed", path: "local.echo", upstreamOutcome: "not_started" });
    await expect(tack.call("local.echo", { query: 42 })).rejects.toBeInstanceOf(TackError);
    expect(state.calls).toBe(before + 1);
    await expect(tack.call("local.nothing")).resolves.toMatchObject({ data: null });
    await expect(tack.call("local.unavailable")).resolves.toMatchObject({ data: { actual: "delivered" } });
  });

  it("uses canonical operations and injected discriminators, never a relative alias", async () => {
    const tack = client({ config: { servers: { a: { transport: "module", entry }, b: { transport: "module", entry } } } });
    await expect(tack.call("records.read", {})).rejects.toMatchObject({ code: "unknown_operation", upstreamOutcome: "not_started" });
    await expect(tack.call("a.records.read", { action: "write", value: "x" })).resolves.toMatchObject({ data: { action: "read", value: "x" } });
    await expect(tack.call("b.records.write", { action: "read" })).resolves.toMatchObject({ data: { action: "write" } });
    await expect(tack.call("search", { query: "echo" })).rejects.toMatchObject({ code: "unknown_operation" });
    await expect(tack.describe("echo")).rejects.toMatchObject({ code: "unknown_operation" });
  });

  it("enforces policy on calls and discovery and writes the existing audit format", async () => {
    const dir = await temp();
    const audit = join(dir, "audit.jsonl");
    const tack = client({ config: {
      servers: { local: { transport: "module", entry } },
      security: { deniedOperations: ["local.echo"], auditLog: { path: audit } }
    } });
    const before = state.calls;
    await expect(tack.call("local.echo", { query: "denied" })).rejects.toMatchObject({ code: "operation_denied", upstreamOutcome: "not_started" });
    expect(state.calls).toBe(before);
    expect((await tack.search({ query: "" })).items.every(item => item.path !== "local.echo")).toBe(true);
    await expect(tack.describe("local.echo")).rejects.toMatchObject({ code: "operation_denied" });
    await tack.call("local.nothing");
    await tack.call("unknown.path").catch(() => undefined);
    const events = (await readFile(audit, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "tool_call", path: "local.echo", allowed: false, ok: false });
    expect(events[1]).toMatchObject({ type: "tool_call", path: "local.nothing", allowed: true, ok: true, upstreamOutcome: "succeeded" });
    expect(events[2]).toMatchObject({ path: "unknown.path", allowed: false });
  });

  it("describes and searches without sandbox truncation", async () => {
    const tack = client();
    const results = await tack.search({ query: "echo" });
    expect(results.items[0]?.path).toBe("local.echo");
    const description = await tack.describe("local.echo");
    expect(description.inputSchema).toMatchObject({ required: ["query"] });
    expect(description.outputSchema).toMatchObject({ required: ["missing"] });
    expect(description.inputTypeScript).toContain("query");
  });

  it.each(["describe", "search"])("detaches %s metadata from later discovery, policy and validation", async source => {
    const tack = client({ config: {
      servers: { local: { transport: "module", entry } },
      security: { deniedOperations: ["local.records.write"] }
    } });
    const read = await tack.describe("local.records.read");
    const originalRead = structuredClone(read);
    expect(Reflect.set(read.injectedArgs!, "action", "write")).toBe(true);
    Reflect.set(read.examples, "0", "mutated example");
    Reflect.set(read, "path", "local.records.write");

    const discover = async () => source === "describe"
      ? tack.describe("local.echo")
      : (await tack.search({ query: "echo" })).items.find(item => item.path === "local.echo")!;
    const metadata = await discover();
    const original = structuredClone(metadata);
    // Deliberately bypass readonly declarations, as ordinary JavaScript can.
    const schema = metadata.inputSchema as Record<string, any>;
    schema.required.length = 0;
    schema.properties.query.type = "number";
    schema.properties.filter.required.length = 0;
    schema.properties.filter.properties.tag.type = "number";
    schema.properties.extra = { type: "boolean" };
    Reflect.set(metadata, "description", "mutated description");
    if ("outputSchema" in metadata) {
      (metadata.outputSchema as Record<string, any>).properties.missing.type = "string";
    }
    if ("params" in metadata) Reflect.set(metadata.params!, "0", "mutated param");
    expect(await discover()).toEqual(original);
    expect(await tack.describe("local.records.read")).toEqual(originalRead);
    expect((await tack.search({ query: "records" })).items.some(item => item.path === "local.records.write")).toBe(false);
    const before = state.calls;
    for (const args of [{}, { query: 42 }, { query: "x", filter: {} }, { query: "x", filter: { tag: 42 } }]) {
      await expect(tack.call("local.echo", args)).rejects.toMatchObject({ code: "input_validation_failed", upstreamOutcome: "not_started" });
    }
    await expect(tack.call("local.records.write")).rejects.toMatchObject({ code: "operation_denied", upstreamOutcome: "not_started" });
    await expect(tack.describe("local.records.write")).rejects.toMatchObject({ code: "operation_denied" });
    expect(state.calls).toBe(before);
    await expect(tack.call("local.records.read")).resolves.toMatchObject({ data: { action: "read" } });
    await expect(tack.call("local.echo", { query: "x", filter: { tag: "valid" } })).resolves.toMatchObject({ data: { query: "x" } });
    expect(state.calls).toBe(before + 2);
  });

  it("normalizes only opted-in returned data, not outgoing queries", async () => {
    const tack = client({ config: {
      servers: { clean: { transport: "module", entry }, raw: { transport: "module", entry } },
      runtime: { normalizeWhitespace: ["clean"] }
    } });
    const query = 'select  *\n from logs where message = "hello  world"';
    const raw = await tack.call("raw.echo", { query });
    expect(raw.data).toEqual({ query });
    const clean = await tack.call("clean.echo", { query });
    expect(clean.data).not.toEqual(raw.data);
    // Output normalization is permitted to collapse quotes in returned strings;
    // HTTP fixture tests separately capture the exact upstream argument bytes.
  });

  it("returns stable errors for genuine tool failures", async () => {
    const tack = client();
    await expect(tack.call("local.boom")).rejects.toMatchObject({ name: "TackError", code: "tool_error", path: "local.boom", upstreamOutcome: "failed", message: "fixture tool failed" });
  });

  it("forwards independent per-call timeout and cancellation, then remains usable", async () => {
    const tack = client();
    await tack.ready();
    // Warm the module runtime too: the deadline includes lazy definition loading.
    await tack.call("local.echo", { query: "warm" });
    const before = state.aborted;
    const timeoutOptions = { timeoutMs: 20 };
    const timed = tack.call("local.wait", {}, timeoutOptions);
    timeoutOptions.timeoutMs = 5000;
    await expect(timed).rejects.toMatchObject({ code: "tool_timeout", upstreamOutcome: "unknown", path: "local.wait" });
    expect(state.aborted).toBe(before + 1);
    const controller = new AbortController();
    const started = state.started;
    const cancelled = tack.call("local.wait", {}, { signal: controller.signal });
    const rejected = expect(cancelled).rejects.toMatchObject({ code: "cancelled", upstreamOutcome: "unknown", cause: expect.any(Error) });
    await expect.poll(() => state.started).toBe(started + 1);
    controller.abort(new Error("stop"));
    await rejected;
    expect(state.aborted).toBe(before + 2);
    await expect(tack.call("local.nothing")).resolves.toMatchObject({ data: null });
  });

  it("does not initialize for pre-aborted calls and rejects invalid options", async () => {
    const tack = client({ configPath: "/missing-sdk-config.json" });
    await expect(tack.call("local.wait", {}, { signal: AbortSignal.abort("stop") })).rejects.toMatchObject({ code: "cancelled", upstreamOutcome: "not_started" });
    for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
      await expect(tack.call("local.wait", {}, { timeoutMs })).rejects.toMatchObject({ code: "invalid_options" });
    }
    await expect(tack.ready()).rejects.toMatchObject({ code: "initialization_failed" });
  });

  it.each(["configPath", "config", "configDir"])("rejects accessor and inherited %s selectors without running getters", key => {
    let getterCalls = 0;
    for (const inherited of [false, true]) {
      for (const descriptor of [
        { get: () => { getterCalls++; throw new Error("selector getter ran"); } },
        { set: (_value: unknown) => { throw new Error("selector setter ran"); } }
      ]) {
        const holder = Object.defineProperty({}, key, descriptor);
        const options = inherited ? Object.create(holder) : holder;
        expect(() => client(options)).toThrow(expect.objectContaining({ code: "invalid_options" }));
      }
    }
    const inheritedData = Object.create({ [key]: key === "config" ? { servers: {} } : "./other.json" });
    expect(() => client(inheritedData)).toThrow(expect.objectContaining({ code: "invalid_options" }));
    expect(getterCalls).toBe(0);
  });

  it.each([null, false, 42, "./config.json", [], () => undefined].map(options => ({ options })))("rejects non-object constructor options: $options", ({ options }) => {
    expect(() => client(options as unknown as TackOptions)).toThrow(expect.objectContaining({ code: "invalid_options" }));
  });

  it("accepts null-prototype options and non-enumerable own data selectors", async () => {
    const options = Object.defineProperty(Object.create(null), "config", {
      value: { servers: { local: { transport: "module", entry } } }
    });
    await expect(client(options).call("local.nothing")).resolves.toMatchObject({ data: null });
  });

  it("has a stable initialization failure and idempotent close", async () => {
    const tack = client({ configPath: "/missing-sdk-config.json" });
    const first = await tack.ready().catch(error => error);
    expect(first).toBeInstanceOf(TackError);
    expect(await tack.ready().catch(error => error)).toBe(first);
    const closing = tack.close();
    expect(tack.close()).toBe(closing);
    await closing;
    await tack[Symbol.asyncDispose]();
    await expect(tack.search()).rejects.toMatchObject({ code: "client_closed" });
    await expect(tack.call("local.echo")).rejects.toMatchObject({ code: "client_closed" });
  });

  it("close cancels active invocations and settles all callers", async () => {
    const tack = client();
    const started = state.started;
    const a = tack.call("local.wait");
    const b = tack.call("local.wait");
    const settled = Promise.allSettled([a, b]);
    await expect.poll(() => state.started).toBe(started + 2);
    await tack.close();
    for (const outcome of await settled) expect(outcome).toMatchObject({ status: "rejected", reason: { code: "cancelled", upstreamOutcome: "unknown" } });
  });

  it("snapshots inline config and own-data args without running accessors", async () => {
    const config: TackConfig = { servers: { local: { transport: "module", entry: "./tools.ts" } } };
    const tack = client({ config, configDir: fixtureDir });
    Reflect.set(config.servers, "local", { transport: "module", entry: "/missing" });
    const args = Object.assign(Object.create({ injected: true }), { query: "original" }) as Record<string, unknown>;
    Object.defineProperty(args, "poison", { enumerable: true, get: () => { throw new Error("getter invoked"); } });
    const pending = tack.call("local.echo", args);
    args.query = "mutated";
    await expect(pending).resolves.toMatchObject({ data: { query: "original" } });
  });

  it("resolves file-relative modules and snapshots configPath before chdir", async () => {
    const dir = await temp();
    const path = join(dir, "tack.config.json");
    await writeFile(join(dir, "tools.mjs"), `export * from ${JSON.stringify(pathToFileURL(entry).href)};\n`);
    await writeFile(path, JSON.stringify({ servers: { local: { transport: "module", entry: "./tools.mjs" } } }));
    const previous = process.cwd();
    let tack: ReturnType<typeof client>;
    try {
      process.chdir(dir);
      tack = client();
      process.chdir(dirname(dir));
      await expect(tack.call("local.nothing")).resolves.toMatchObject({ data: null });
    } finally { process.chdir(previous); }
    const relative = client({ config: { servers: { local: { transport: "module", entry: "./tools.ts" } } }, configDir: fixtureDir });
    await relative.ready();
  });
});

// Without project declarations, results stay unknown.
function typeContracts(dynamic: Tack) {
  void dynamic.tools["local"]!["echo"]!({ query: "x" }).then(result => {
    // @ts-expect-error dynamic data is unknown, not an implicit any
    return result.data.query;
  });
}
void typeContracts;
