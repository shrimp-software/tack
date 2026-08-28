import { createMcpToolRuntime, discoverMcpServers } from "@tack/mcp";

import type { Source } from "../source.js";

/**
 * MCP servers over stdio or Streamable HTTP.
 * Adapter only — the implementation lives in `@tack/mcp`.
 */
export const mcpSource: Source = {
  transports: ["stdio", "http"],
  discover: (entries) => discoverMcpServers(entries),
  createRuntime: (input) => createMcpToolRuntime(input)
};
