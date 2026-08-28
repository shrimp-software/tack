import {
  ownDataEntries,
  ownDataValue as ownValue,
  type DiscoveredServer,
  type TackConfig,
  type TackServerConfig
} from "@tack/core";

import { discoverModuleSource } from "../module/discover.js";
import { createModuleRuntime } from "../module/runtime.js";
import type { Source } from "../source.js";

/** Local TypeScript / JavaScript files that export `defineTool()` tools. */
export const moduleSource: Source = {
  transports: ["module"],
  discover: (config): Promise<DiscoveredServer[]> =>
    Promise.all(
      moduleRefs(config).map(([serverId, entry]) => discoverModuleSource({ serverId, entry }))
    ),
  createRuntime: ({ manifest }) => createModuleRuntime({ manifest })
};

function moduleRefs(config: TackConfig): [string, string][] {
  return ownDataEntries<TackServerConfig>(ownValue<TackConfig["servers"]>(config, "servers")).flatMap(
    ([serverId, serverConfig]) =>
      serverConfig.transport === "module" ? [[serverId, serverConfig.entry]] : []
  );
}
