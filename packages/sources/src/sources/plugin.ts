import { pluginSourceKind } from "@tack/core";
import { createPluginToolRuntime, discoverPluginServers } from "@tack/plugin";

import type { Source } from "../source.js";

/**
 * Plugin bundles — one namespace per plugin, exposing its skills as data and its
 * bundled MCP servers under `mcp.<server>.<op>`. Adapter only; the
 * implementation lives in `@tack/plugin`. The top-level `plugins` config block
 * is desugared into `plugin` sources by `resolvePluginsIntoConfig` in
 * `dispatch.ts` before discovery runs.
 */
export const pluginSource: Source = {
  kinds: [pluginSourceKind],
  discover: (entries) => discoverPluginServers(entries),
  createRuntime: (input) => createPluginToolRuntime(input)
};
