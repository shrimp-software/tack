import { httpSourceKind, stdioSourceKind } from "@tack/core";
import { createMcpToolRuntime, discoverMcpServers } from "@tack/mcp";

import type { Source } from "../source.js";

/**
 * MCP servers over stdio or Streamable HTTP.
 * Adapter only — the implementation lives in `@tack/mcp`.
 */
export const mcpSource: Source = {
  kinds: [stdioSourceKind, httpSourceKind],
  discover: (entries) => discoverMcpServers(entries),
  createRuntime: (input) => createMcpToolRuntime(input)
};
