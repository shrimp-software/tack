import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import { ownDataValue as ownValue } from "../own-data.js";
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
    const entry = ownValue<string>(config, "entry");
    if (typeof entry !== "string") {
      return undefined;
    }

    return { transport: "module", entry };
  },
  resolvePaths(config, baseDir) {
    return isAbsolute(config.entry)
      ? config
      : { ...config, entry: resolve(baseDir, config.entry) };
  }
};
