import type { TackConfig } from "./types.js";

export const DEFAULT_CONFIG_PATH = "tack.config.json";
export const DEFAULT_OUTPUT_DIR = ".tack/generated";

export function createDefaultConfig(): TackConfig {
  return {
    servers: {
      example: {
        transport: "stdio",
        command: "node",
        args: ["./mcp-server.js"],
        env: {}
      }
    },
    runtime: {
      type: "quickjs",
      timeoutMs: 30_000,
      memoryMb: 128,
      maxStackBytes: 1_000_000,
      maxOutputBytes: 1_000_000,
      maxToolCalls: 100,
      maxToolRequestBytes: 1_000_000,
      maxToolResponseBytes: 1_000_000
    },
    output: {
      dir: DEFAULT_OUTPUT_DIR
    }
  };
}
