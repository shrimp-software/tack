import { defineTool } from "@cbxss/tack-sources";

export const state = { calls: 0, aborted: 0, started: 0 };
export const echo = defineTool({
  name: "echo",
  description: "Echo a query without rewriting it",
  input: { type: "object", properties: { query: { type: "string" }, filter: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] } }, required: ["query"], additionalProperties: false },
  // Deliberately stale output declaration: delivery is not gated by it.
  output: { type: "object", properties: { missing: { type: "number" } }, required: ["missing"] },
  handler: (args: { query: string }) => { state.calls++; return { query: args.query }; }
});
export const manage = defineTool({
  name: "manage_records",
  input: { type: "object", properties: { action: { type: "string", enum: ["read", "write"] }, value: { type: "string" } }, required: ["action"] },
  handler: (args: unknown) => { state.calls++; return args; }
});
export const nothing = defineTool({ name: "nothing", handler: () => null });
export const boom = defineTool({ name: "boom", handler: () => { throw new Error("fixture tool failed"); } });
export const wait = defineTool({
  name: "wait",
  handler: (_args: unknown, { signal }) => new Promise((_resolve, reject) => {
    state.started++;
    const abort = () => { state.aborted++; reject(signal?.reason); };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  })
});
export const unavailable = defineTool({
  name: "unavailable",
  output: { $ref: "https://invalid.example/schema.json" },
  handler: () => ({ actual: "delivered" })
});
