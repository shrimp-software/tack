// Ref parsing + git fetch + lockfile.
export { parsePluginRef, type ParsedPluginRef } from "./ref.js";
export { resolveCommit, ensureCheckout } from "./fetch.js";
export {
  readLock,
  writeLock,
  withLockEntry,
  withoutLockEntry,
  type PluginLock,
  type PluginLockEntry
} from "./lock.js";

// Layout reading.
export {
  readPluginLayout,
  type PluginJson,
  type PluginLayout,
  type PluginSkill,
  type PluginBundledMcpServer
} from "./layout.js";

// Skill-as-data.
export {
  readSkillData,
  SKILL_INPUT_SCHEMA,
  SKILL_OUTPUT_SCHEMA,
  type SkillData
} from "./skill.js";

// Discovery + runtime — the `Source` behaviour, adapted in `@tack/sources`.
export { discoverPluginServers } from "./discover.js";
export {
  createPluginToolRuntime,
  type CreatePluginToolRuntimeOptions
} from "./runtime.js";

// Config desugaring — `plugins` block → synthetic `plugin` sources.
export { resolvePluginsIntoConfig, type ResolvePluginsOptions } from "./resolve.js";
export { createPluginMount, type PluginMount } from "./mount.js";
