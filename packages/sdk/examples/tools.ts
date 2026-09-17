import { defineTool } from "@cbxss/tack-sources";

export const echo = defineTool({
  name: "echo",
  input: {
    type: "object", properties: { message: { type: "string" } },
    required: ["message"], additionalProperties: false
  },
  output: { type: "string" },
  handler: ({ message }: { message: string }) => message
});
