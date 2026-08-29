import { moduleSourceKind, type DiscoveredServer } from "@tack/core";

import { discoverModuleSource } from "../module/discover.js";
import { createModuleRuntime } from "../module/runtime.js";
import type { Source, SourceServerEntry } from "../source.js";

/**
 * Local TypeScript / JavaScript files that export `defineTool()` tools.
 * Adapter only — the implementation lives in `../module/`.
 */
export const moduleSource: Source = {
  kinds: [moduleSourceKind],
  discover: (entries) => Promise.all(entries.flatMap(discoverEntry)),
  createRuntime: (input) => createModuleRuntime(input)
};

function discoverEntry([serverId, config]: SourceServerEntry): Promise<DiscoveredServer>[] {
  return config.transport === "module"
    ? [discoverModuleSource({ serverId, entry: config.entry })]
    : [];
}
