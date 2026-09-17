import assert from "node:assert/strict";
import { Tack, TackError, type TackResponse } from "@cbxss/tack-sdk";

export async function runDynamic(): Promise<void> {
  const tack: Tack = new Tack({ configPath: "./tack.config.json" });
  try {
    assert.ok(tack instanceof Tack);
    const response: TackResponse = await tack.tools.kibana.kubelogs.search(
      { namespace: "fixture", query: "dynamic" },
      { signal: new AbortController().signal, timeoutMs: 5000 }
    );
    assert.deepEqual(response.data, { query: "dynamic", count: 1 });
    const extracted = tack.tools.kibana.status.get;
    assert.equal((await extracted()).data, true);
    await assert.rejects(tack.call("missing.path"), TackError);
  } finally {
    await tack.close();
  }
}

function typeContracts() {
  const tack: Tack = new Tack({ config: { servers: {} }, configDir: "." });
  const clients: Tack[] = [new Tack(), new Tack(undefined), new Tack({}), new Tack({ configPath: "./tack.config.json" }), tack];
  function open(): Tack { return new Tack({ configPath: "./tack.config.json" }); }
  void [clients, open];
  void tack.tools.any.namespace({ anything: "JSON object" });
  void tack.tools.any.namespace(undefined, { signal: new AbortController().signal, timeoutMs: 50 });
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
  const response: Promise<TackResponse> = result;
  const inferred = preserveCall(extracted);
  const inferredResponse: Promise<TackResponse> = inferred(...args);
  void [response, inferredResponse];
  // @ts-expect-error tool-tree overrides are not constructor options
  new Tack<{ kibana: unknown }>();
  // @ts-expect-error config sources are mutually exclusive
  new Tack({ configPath: "x", config: {} });
  // @ts-expect-error arguments must be object-shaped
  tack.tools.any.namespace("not an object");
  // @ts-expect-error timeout must be numeric
  tack.tools.any.namespace({}, { timeoutMs: "slow" });
  // @ts-expect-error signal must be an AbortSignal
  tack.tools.any.namespace({}, { signal: false });
  void tack.tools.any.namespace().then(result => {
    // @ts-expect-error dynamic data is unknown
    result.data.query;
    // @ts-expect-error live results do not expose the static raw contract
    result.raw;
  });
  // @ts-expect-error importing the SDK does not supply code-mode globals
  tools.any.namespace();
  // @ts-expect-error importing the SDK does not supply code-mode globals
  emit({});
  // @ts-expect-error importing the SDK does not supply code-mode globals
  shape({});
}
void typeContracts;

function preserveCall<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result {
  return fn;
}
