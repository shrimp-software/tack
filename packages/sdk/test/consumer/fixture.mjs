import { defineTool } from "@cbxss/tack-sources";

export const state = { calls: 0 };
export const search = defineTool({
  name: "search_kubelogs",
  description: "Search the local consumer fixture, not a live Kibana server.",
  input: {
    type: "object", properties: { namespace: { type: "string" }, query: { type: "string" } },
    required: ["namespace", "query"], additionalProperties: false
  },
  output: { type: "object", properties: { query: { type: "string" }, count: { type: "number" } }, required: ["query", "count"], additionalProperties: false },
  handler: ({ query }) => { state.calls++; return { query, count: 1 }; }
});
export const status = defineTool({
  name: "get_status", input: { type: "object", properties: { verbose: { type: "boolean" } }, additionalProperties: false },
  output: { type: "boolean" }, handler: () => true
});
export const unknown = defineTool({ name: "unknown", handler: () => null });
export const records = defineTool({
  name: "manage_records",
  input: { type: "object", properties: { action: { type: "string", enum: ["read", "write"] }, value: { type: "string" } }, required: ["action"], additionalProperties: false },
  handler: args => ({ ...args })
});
export const name = defineTool({ name: "name", handler: () => "name" });
export const length = defineTool({ name: "length", handler: () => "length" });
export const call = defineTool({ name: "call", handler: () => "call" });
export const constructor = defineTool({ name: "constructor", handler: () => "constructor" });
export const prototype = defineTool({ name: "prototype", handler: () => "prototype" });
