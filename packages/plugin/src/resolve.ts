import { isAbsolute, join, resolve } from "node:path";

import {
  TackPluginError,
  type PluginRef,
  type TackConfig,
  type TackServerConfig
} from "@tack/core";

import { ensureCheckout } from "./fetch.js";
import { readLock, type PluginLock } from "./lock.js";
import { parsePluginRef } from "./ref.js";

export interface ResolvePluginsOptions {
  /** Directory the config file lives in — anchors local `path`s and the lockfile. */
  readonly configDir: string;
}

/**
 * Expand a config's top-level `plugins` block into synthetic `plugin` sources
 * (one per plugin, added to `servers`) with resolved absolute paths, and drop
 * the `plugins` key. A config with no `plugins` is returned untouched, so this
 * is safe to call more than once and on already-resolved configs.
 */
export async function resolvePluginsIntoConfig(
  config: TackConfig,
  options: ResolvePluginsOptions
): Promise<TackConfig> {
  const plugins = config.plugins;
  if (!plugins || Object.keys(plugins).length === 0) {
    return config;
  }

  const configDir = resolve(options.configDir);
  const lock = await readLock(join(configDir, "tack.plugins.lock"));
  const cacheRoot = join(configDir, ".tack", "plugins");

  const synthetic: Record<string, TackServerConfig> = {};
  for (const [name, ref] of Object.entries(plugins)) {
    if (config.servers[name]) {
      throw new TackPluginError({
        message: `Plugin "${name}" collides with a servers entry of the same name`,
        pluginName: name
      });
    }
    synthetic[name] = {
      transport: "plugin",
      path: await resolvePluginPath(name, ref, { configDir, cacheRoot, lock })
    };
  }

  const next: TackConfig = { ...config, servers: { ...config.servers, ...synthetic } };
  delete (next as { plugins?: unknown }).plugins;
  return next;
}

async function resolvePluginPath(
  name: string,
  ref: PluginRef,
  ctx: {
    readonly configDir: string;
    readonly cacheRoot: string;
    readonly lock: PluginLock;
  }
): Promise<string> {
  const parsed = parsePluginRef(ref, name);
  if (parsed.kind === "local") {
    return isAbsolute(parsed.path) ? parsed.path : resolve(ctx.configDir, parsed.path);
  }

  const locked = ctx.lock.plugins[name];
  if (!locked) {
    throw new TackPluginError({
      message: `Plugin "${name}" is a git source but is not in tack.plugins.lock — run \`tack plugins add\``,
      pluginName: name
    });
  }
  if (
    locked.source !== parsed.source ||
    locked.ref !== parsed.ref ||
    locked.subdir !== parsed.subdir
  ) {
    throw new TackPluginError({
      message: `Plugin "${name}" does not match its tack.plugins.lock entry — run \`tack plugins update ${name}\``,
      pluginName: name
    });
  }

  return ensureCheckout({
    ref: parsed,
    commit: locked.resolvedCommit,
    cacheRoot: ctx.cacheRoot
  });
}
