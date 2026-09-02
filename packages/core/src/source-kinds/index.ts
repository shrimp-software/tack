import type { SourceKind } from "../source-kind.js";
import { httpSourceKind } from "./http.js";
import { moduleSourceKind } from "./module.js";
import { pluginSourceKind } from "./plugin.js";
import { stdioSourceKind } from "./stdio.js";

export { httpSourceKind } from "./http.js";
export { moduleSourceKind } from "./module.js";
export { pluginSourceKind } from "./plugin.js";
export { stdioSourceKind } from "./stdio.js";

/**
 * The source kinds `@cbxss/tack-core` ships. `parseConfig`, `buildManifest`, and
 * `loadConfig` fall back to this list; a consumer that adds a kind threads
 * `[...BUILTIN_SOURCE_KINDS, myKind]` through those calls instead.
 */
export const BUILTIN_SOURCE_KINDS: readonly SourceKind[] = [
  stdioSourceKind,
  httpSourceKind,
  moduleSourceKind,
  pluginSourceKind
];
