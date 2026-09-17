import { pluginSourceKind, TackRuntimeError, type TackRuntime, type TackTool } from "@cbxss/tack-core";
import { createPluginToolRuntime, discoverPluginServers } from "@cbxss/tack-plugin";

import type { Source } from "../source.js";

/**
 * Plugin bundles — one namespace per plugin, exposing its skills as data and its
 * bundled MCP servers under `mcp.<server>.<op>`. Adapter only; the
 * implementation lives in `@cbxss/tack-plugin`. The top-level `plugins` config block
 * is desugared into `plugin` sources by `resolvePluginsIntoConfig` in
 * `dispatch.ts` before discovery runs.
 */
export const pluginSource: Source = {
  kinds: [pluginSourceKind],
  discover: (entries) => discoverPluginServers(entries),
  createRuntime: async ({ config, tools }) => {
    // The plugin implementation owns one mount. Keep identically named bundled
    // servers in different mounts isolated, routing by the original tool id.
    const toolsByMount = new Map<string, TackTool[]>();
    for (const tool of tools) {
      const group = toolsByMount.get(tool.serverId) ?? [];
      group.push(tool);
      toolsByMount.set(tool.serverId, group);
    }
    const created = await Promise.allSettled([...toolsByMount.values()].map(async tools => ({
      tools, runtime: await createPluginToolRuntime({ config, tools })
    })));
    const mounts = created.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    const failure = created.find(result => result.status === "rejected");
    if (failure?.status === "rejected") {
      await Promise.allSettled(mounts.map(mount => mount.runtime.close()));
      throw failure.reason;
    }
    const routes = new Map<string, TackRuntime>();
    for (const mount of mounts) for (const tool of mount.tools) routes.set(tool.id, mount.runtime);
    let closed = false;
    let closePromise: Promise<void> | undefined;
    return {
      invoke: (toolId, args, options) => {
        const runtime = routes.get(toolId);
        if (closed || !runtime) throw new TackRuntimeError({
          message: closed ? "Plugin source runtime is closed" : `Unknown plugin tool: ${toolId}`, toolId
        });
        return runtime.invoke(toolId, args, options);
      },
      close: () => {
        if (closePromise) return closePromise;
        closed = true;
        closePromise = Promise.allSettled(mounts.map(mount => mount.runtime.close())).then(results => {
          const failure = results.find(result => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        });
        return closePromise;
      }
    };
  }
};
