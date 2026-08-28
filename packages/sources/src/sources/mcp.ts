import { createMcpRuntime, discoverMcpServers } from "@tack/mcp";

import type { Source } from "../source.js";

/** MCP servers reached over stdio or Streamable HTTP. */
export const mcpSource: Source = {
  transports: ["stdio", "http"],
  discover: (config) => discoverMcpServers(config),
  createRuntime: (input) => createMcpRuntime(input)
};
