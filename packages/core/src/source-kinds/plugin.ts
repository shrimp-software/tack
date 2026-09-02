import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import type { SourceKind } from "../source-kind.js";
import type { PluginServerConfig } from "../types.js";

const PluginServerConfigSchema = z.object({
  transport: z.literal("plugin"),
  path: z.string().min(1)
}) satisfies z.ZodType<PluginServerConfig>;

/**
 * A plugin bundle mounted as one namespace. This kind only ever sees the
 * desugared form — a local `path` — because `@cbxss/tack-plugin` resolves the
 * top-level `plugins` block (git fetch / anchoring) into `plugin` sources before
 * config parsing.
 */
export const pluginSourceKind: SourceKind<PluginServerConfig> = {
  transport: "plugin",
  configSchema: PluginServerConfigSchema,
  connection(config) {
    return typeof config.path === "string"
      ? { transport: "plugin", pluginPath: config.path }
      : undefined;
  },
  resolvePaths(config, baseDir) {
    return isAbsolute(config.path)
      ? config
      : { ...config, path: resolve(baseDir, config.path) };
  }
};
