import { z } from "zod";

import type { SourceKind } from "../source-kind.js";
import type { StdioServerConfig } from "../types.js";

const StdioServerConfigSchema = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  inheritEnv: z.boolean().optional(),
  cwd: z.string().optional()
}) satisfies z.ZodType<StdioServerConfig>;

/** MCP servers spawned as a child process and spoken to over stdio. */
export const stdioSourceKind: SourceKind<StdioServerConfig> = {
  transport: "stdio",
  configSchema: StdioServerConfigSchema,
  connection(config) {
    if (typeof config.command !== "string") {
      return undefined;
    }
    return {
      transport: "stdio",
      command: config.command,
      ...(config.args?.length ? { args: config.args } : {}),
      ...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
      ...(config.inheritEnv === true ? { inheritEnv: true } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {})
    };
  }
};
