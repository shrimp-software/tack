import { moduleSourceKind, type DiscoveredServer } from "@cbxss/tack-core";

import { discoverModuleSource } from "../module/discover.js";
import { createModuleRuntime } from "../module/runtime.js";
import type { Source, SourceServerEntry } from "../source.js";

/**
 * Local TypeScript / JavaScript files that export `defineTool()` tools.
 * Adapter only — the implementation lives in `../module/`.
 */
export const moduleSource: Source = {
  kinds: [moduleSourceKind],
  discover: async (entries) => {
    const discovered = await Promise.allSettled(entries.flatMap(discoverEntry));
    const failure = discovered.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return discovered.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  },
  createRuntime: (input) => createModuleRuntime(input)
};

function discoverEntry([serverId, config]: SourceServerEntry): Promise<DiscoveredServer>[] {
  return config.transport === "module"
    ? [discoverModuleSource({ serverId, entry: config.entry })]
    : [];
}
