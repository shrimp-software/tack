import assert from "node:assert/strict";
import { Tack, TackError, type TackResponse } from "@cbxss/tack-sdk";

export async function runTyped(): Promise<void> {
  const tack = new Tack({ configPath: "./tack.config.json" });
  try {
    const response = await tack.tools.kibana.kubelogs.search(
      { namespace: "fixture", query: "level:error" },
      { signal: new AbortController().signal, timeoutMs: 5000 }
    );
    const typed: TackResponse<{ query: string; count: number }> = response;
    assert.deepEqual(typed.data, { query: "level:error", count: 1 });
    assert.equal(response.responseId, null);
    assert.equal(await tack.tools.kibana.status.get().then(result => result.data), true);
    const optional: boolean = (await tack.tools.kibana.status.get(undefined, { timeoutMs: 5000 })).data;
    assert.equal(optional, true);
    const extracted = tack.tools.kibana.status.get;
    assert.equal((await extracted()).data, true);
    for (const key of ["toString", "constructor", "bind", "call", "apply", "name", "length", "arguments", "caller", "prototype", "then", "toJSON"]) {
      assert.equal(Reflect.get(extracted, key), undefined);
    }
    assert.deepEqual((await tack.tools.kibana.records.read()).data, { action: "read" });
    assert.equal((await tack.tools.kibana.unknown()).data, null);
    for (const key of ["name", "length", "call", "constructor", "prototype"]) {
      assert.equal(Reflect.get(tack.tools.kibana, key), undefined);
      assert.equal((await tack.call(`kibana.${key}`)).data, key);
    }
    const namespace = tack.tools.kibana;
    assert.equal(await namespace, namespace);
    assert.equal(JSON.stringify(namespace), undefined);
    for (const key of ["then", "toJSON", "__proto__", "toString"]) assert.equal(Reflect.get(namespace, key), undefined);
    await assert.rejects(tack.call("kibana.kubelogs.search", {}), (error: unknown) => error instanceof TackError && error.code === "input_validation_failed");
    await assert.rejects(tack.call("kubelogs.search", {}), (error: unknown) => error instanceof TackError && error.code === "unknown_operation");
    let getterCalls = 0;
    const accessorOptions = { get configPath() { getterCalls++; return "./other.config.json" as const; } };
    assert.throws(() => new Tack(accessorOptions), (error: unknown) => error instanceof TackError && error.code === "invalid_options");
    assert.equal(getterCalls, 0);
    const erasedOptions: {} = { configPath: "./other.config.json" };
    const other = new Tack(erasedOptions);
    try {
      assert.equal((await other.call("secondary.status.get")).data, true);
      await assert.rejects(other.call("kibana.status.get"), (error: unknown) => error instanceof TackError && error.code === "unknown_operation");
    } finally { await other.close(); }
  } finally {
    await tack.close();
  }
}

// These are compiler assertions, never executed.
function typeContracts() {
  const tack = new Tack({ configPath: "./tack.config.json" });
  const inline = new Tack({ config: { servers: {} }, configDir: "." });
  void inline.close();
  const defaults: Tack = new Tack();
  const annotated: Tack = tack;
  const clients: Tack[] = [defaults, annotated];
  function open(): Tack { return new Tack({ configPath: "./tack.config.json" }); }
  const annotationResult: Promise<TackResponse<boolean>> = annotated.tools.kibana.status.get();
  void [clients, open, annotationResult];
  void defaults.tools.kibana.status.get();
  void new Tack<undefined>().tools.kibana.status.get();
  class DefaultTack extends Tack {}
  void new DefaultTack().tools.kibana.status.get();
  // @ts-expect-error a default-bound subclass cannot silently take another config
  new DefaultTack({ configPath: "./other.config.json" });
  const explicitDefault = new Tack(undefined);
  void explicitDefault.tools.kibana.status.get();
  const erasedOptions: {} = { configPath: "./other.config.json" };
  const erasedInlineOptions: {} = { config: { servers: {} } };
  const erased = new Tack(erasedOptions);
  const erasedInline = new Tack(erasedInlineOptions);
  const empty = new Tack({});
  // @ts-expect-error erased config paths must not inherit the default catalog's output
  const erasedResult: Promise<TackResponse<boolean>> = erased.tools["kibana"]!["status"]!["get"]!();
  // @ts-expect-error erased inline configs must not inherit the default catalog's output
  const erasedInlineResult: Promise<TackResponse<boolean>> = erasedInline.tools["kibana"]!["status"]!["get"]!();
  // @ts-expect-error an explicitly supplied {} does not prove that runtime options are absent
  const emptyResult: Promise<TackResponse<boolean>> = empty.tools["kibana"]!["status"]!["get"]!();
  void [erasedResult, erasedInlineResult, emptyResult];
  // @ts-expect-error a config-specific generic requires corresponding runtime options
  new Tack<{ configPath: "./other.config.json" }>();
  // @ts-expect-error undefined cannot satisfy a required config path
  new Tack<{ configPath: "./other.config.json" }>(undefined);
  // @ts-expect-error inline config generics also require their runtime options
  new Tack<{ config: { servers: {} } }>();
  const explicit = new Tack<{ configPath: "./other.config.json" }>({ configPath: "./other.config.json" });
  void explicit.tools.secondary.status.get();
  class OtherTack extends Tack<{ configPath: "./other.config.json" }> {}
  const subclass = new OtherTack({ configPath: "./other.config.json" });
  void subclass.tools.secondary.status.get();
  // @ts-expect-error subclasses retain the selected catalog
  subclass.tools.kibana;
  // @ts-expect-error config-specific subclasses still require runtime options
  new OtherTack();
  const maybeOptions = Math.random() ? undefined : { configPath: "./other.config.json" as const };
  const maybe = new Tack(maybeOptions);
  // @ts-expect-error a potentially absent config cannot promise the other catalog
  maybe.tools.secondary.status.get();
  const bare = new Tack({ configPath: "tack.config.json" });
  void bare.tools.kibana.status.get();
  const other = new Tack({ configPath: "./other.config.json" });
  void other.tools.secondary.status.get();
  // @ts-expect-error annotations must not replace another catalog with the default binding
  const wrongCatalog: Tack = other;
  // @ts-expect-error annotations must not turn erased options into the default binding
  const wrongErased: Tack = erased;
  // @ts-expect-error annotations must not turn inline configs into the default binding
  const wrongInline: Tack = inline;
  void [wrongCatalog, wrongErased, wrongInline];
  // @ts-expect-error a different registered config has a different tool tree
  other.tools.kibana;
  // @ts-expect-error catalogs are not merged globally
  tack.tools.secondary;
  const widenedPath: string = process.env.TACK_CONFIG ?? "./tack.config.json";
  const widened = new Tack({ configPath: widenedPath });
  const unregistered = new Tack({ configPath: "./unregistered.json" });
  for (const dynamic of [inline, widened, unregistered]) {
    void dynamic.tools["kibana"]!["status"]!["get"]!().then(result => {
      // @ts-expect-error inline, unregistered, and widened paths never inherit project output types
      result.data.count;
    });
  }
  // @ts-expect-error null-prototype namespaces have no callable Object members
  tack.tools.toString();
  // @ts-expect-error null-prototype namespaces have no callable Object members
  tack.tools.hasOwnProperty("x");
  // @ts-expect-error null-prototype namespaces have no callable Object members
  tack.tools.constructor();
  // @ts-expect-error null-prototype namespaces have no callable Object members
  tack.tools.kibana.toString();
  // @ts-expect-error null-prototype namespaces have no callable Object members
  tack.tools.kibana.hasOwnProperty("x");
  // @ts-expect-error null-prototype namespaces have no callable Object members
  tack.tools.kibana.constructor();
  // @ts-expect-error null-prototype namespaces have no callable Object members
  tack.tools.kibana.kubelogs.toString();
  // @ts-expect-error null-prototype namespaces have no callable Object members
  tack.tools.kibana.kubelogs.hasOwnProperty("x");
  // @ts-expect-error null-prototype namespaces have no callable Object members
  tack.tools.kibana.kubelogs.constructor();
  // @ts-expect-error null-prototype proxies have no Function members
  tack.tools.bind(undefined);
  // @ts-expect-error null-prototype proxies have no Function members
  tack.tools.call(undefined);
  // @ts-expect-error null-prototype proxies have no Function members
  tack.tools.apply(undefined, []);
  // @ts-expect-error null-prototype proxies have no Function members
  tack.tools.kibana.bind(undefined);
  // @ts-expect-error null-prototype proxies have no Function members
  tack.tools.kibana.call(undefined);
  // @ts-expect-error null-prototype proxies have no Function members
  tack.tools.kibana.apply(undefined, []);
  // @ts-expect-error null-prototype proxies have no Function members
  tack.tools.kibana.kubelogs.bind(undefined);
  // @ts-expect-error null-prototype proxies have no Function members
  tack.tools.kibana.kubelogs.call(undefined);
  // @ts-expect-error null-prototype proxies have no Function members
  tack.tools.kibana.kubelogs.apply(undefined, []);
  const leaf = tack.tools.kibana.status.get;
  // @ts-expect-error callable leaves have no prototype or serialization members
  leaf.toString();
  // @ts-expect-error callable leaves have no prototype or serialization members
  leaf.constructor();
  // @ts-expect-error callable leaves have no prototype or serialization members
  leaf.bind(undefined);
  // @ts-expect-error callable leaves have no prototype or serialization members
  leaf.call(undefined);
  // @ts-expect-error callable leaves have no prototype or serialization members
  leaf.apply(undefined, []);
  // @ts-expect-error callable leaves have no prototype or serialization members
  leaf.name();
  // @ts-expect-error callable leaves have no prototype or serialization members
  leaf.length();
  // @ts-expect-error callable leaves have no prototype or serialization members
  leaf.arguments();
  // @ts-expect-error callable leaves have no prototype or serialization members
  leaf.caller();
  // @ts-expect-error callable leaves have no prototype or serialization members
  leaf.prototype();
  // @ts-expect-error callable leaves have no prototype or serialization members
  leaf.then();
  // @ts-expect-error callable leaves have no prototype or serialization members
  leaf.toJSON();
  const extracted = tack.tools.kibana.kubelogs.search;
  const args: Parameters<typeof extracted> = [{ namespace: "fixture", query: "extracted" }];
  const result: ReturnType<typeof extracted> = extracted(...args);
  const response: Promise<TackResponse<{ query: string; count: number }>> = result;
  const inferred = preserveCall(extracted);
  const inferredResponse: Promise<TackResponse<{ query: string; count: number }>> = inferred(...args);
  void [response, inferredResponse];
  // @ts-expect-error utility types preserve required schema inputs
  const invalidArgs: Parameters<typeof extracted> = [{}];
  // @ts-expect-error generic callable inference preserves schema inputs
  inferred({ query: 42 });
  void invalidArgs;
  // @ts-expect-error tool-tree overrides are not constructor options
  new Tack<{ kibana: unknown }>();
  // @ts-expect-error the constructor forbids config plus configPath
  new Tack({ config: {}, configPath: "x" });
  // @ts-expect-error no namespace index signature
  tack.tools.nonexistent;
  // @ts-expect-error no method index signature
  tack.tools.kibana.kubelogs.missing({});
  // @ts-expect-error required input cannot be omitted
  tack.tools.kibana.kubelogs.search();
  // @ts-expect-error required query
  tack.tools.kibana.kubelogs.search({ namespace: "fixture" });
  // @ts-expect-error schema value type
  tack.tools.kibana.kubelogs.search({ namespace: "fixture", query: 42 });
  // @ts-expect-error schema rejects extra arguments
  tack.tools.kibana.kubelogs.search({ namespace: "fixture", query: "x", extra: true });
  // @ts-expect-error optional argument still has a schema
  tack.tools.kibana.status.get({ verbose: "yes" });
  // @ts-expect-error timeout type
  tack.tools.kibana.status.get(undefined, { timeoutMs: "slow" });
  // @ts-expect-error signal type
  tack.tools.kibana.status.get({}, { signal: true });
  // @ts-expect-error discriminator injection is not caller-controlled
  tack.tools.kibana.records.read({ action: "write" });
  // @ts-expect-error special paths are explicit call-only
  tack.tools.kibana.name();
  // @ts-expect-error special paths are explicit call-only
  tack.tools.kibana.length();
  // @ts-expect-error special paths are explicit call-only
  tack.tools.kibana.call();
  void tack.tools.kibana.kubelogs.search({ namespace: "fixture", query: "x" }).then(result => {
    const count: number = result.data.count;
    // @ts-expect-error output type is not any
    const wrong: string = result.data.count;
    // @ts-expect-error the live result is not the legacy TackResult
    result.raw;
    return [count, wrong];
  });
  void tack.tools.kibana.unknown().then(result => {
    // @ts-expect-error absent output schema is unknown
    result.data.value;
  });
  // @ts-expect-error dynamic escape hatch returns unknown
  void tack.call("kibana.status.get").then(result => result.data.value);
  // @ts-expect-error code-mode globals must not leak through imports
  tools.kibana.status.get();
  // @ts-expect-error code-mode globals must not leak through imports
  emit("value");
  // @ts-expect-error code-mode globals must not leak through imports
  shape({});
}
void typeContracts;

function preserveCall<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result {
  return fn;
}
