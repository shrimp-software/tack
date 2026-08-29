import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import type { SourceKind } from "../source-kind.js";
import type { ModuleServerConfig } from "../types.js";

const ModuleServerConfigSchema = z.object({
  transport: z.literal("module"),
  entry: z.string().min(1)
}) satisfies z.ZodType<ModuleServerConfig>;

/** Local TypeScript / JavaScript files that export `defineTool()` tools. */
export const moduleSourceKind: SourceKind<ModuleServerConfig> = {
  transport: "module",
  configSchema: ModuleServerConfigSchema,
  connection(config) {
    return typeof config.entry === "string" ? { transport: "module", entry: config.entry } : undefined;
  },
  resolvePaths(config, baseDir) {
    return isAbsolute(config.entry)
      ? config
      : { ...config, entry: resolve(baseDir, config.entry) };
  }
};
