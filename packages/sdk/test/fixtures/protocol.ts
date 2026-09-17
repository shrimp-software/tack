export const tools = [{
  name: "echo",
  description: "Fixture echo",
  inputSchema: { type: "object", properties: { query: { type: "string" }, mode: { type: "string" } }, required: ["query"] },
  outputSchema: { type: "object", properties: { declared: { type: "number" } }, required: ["declared"] }
}];

export function result(args: Record<string, unknown>): unknown {
  if (args.mode === "error") return { isError: true, content: [{ type: "text", text: "fixture rejected" }] };
  if (args.mode === "json") return { content: [{ type: "text", text: JSON.stringify({ query: args.query }) }] };
  if (args.mode === "null") return { content: [{ type: "text", text: "null" }] };
  if (args.mode === "text") return { content: [{ type: "text", text: args.query }] };
  return { structuredContent: { query: args.query }, content: [{ type: "text", text: "lower precedence" }] };
}
