import { z } from "zod";

import { ownDataValue as ownValue } from "../own-data.js";
import type { SourceKind } from "../source-kind.js";
import type { StdioServerConfig } from "../types.js";
import { ownStringArray, ownStringRecord } from "./shared.js";

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
    const command = ownValue<string>(config, "command");
    if (typeof command !== "string") {
      return undefined;
    }

    const args = ownStringArray(config, "args");
    const env = ownStringRecord(config, "env");
    const inheritEnv = ownValue<boolean>(config, "inheritEnv");
    const cwd = ownValue<string>(config, "cwd");
    return {
      transport: "stdio",
      command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(inheritEnv === true ? { inheritEnv: true } : {}),
      ...(cwd ? { cwd } : {})
    };
  }
};
