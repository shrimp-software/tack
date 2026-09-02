import { createHash } from "node:crypto";

import { TackPluginError, type PluginRef } from "@cbxss/tack-core";

/** A plugin reference resolved to how it is obtained. */
export type ParsedPluginRef =
  | { readonly kind: "local"; readonly path: string }
  | {
      readonly kind: "git";
      /** Normalised clone URL (e.g. `https://github.com/owner/repo.git`). */
      readonly cloneUrl: string;
      /** The user-facing source string, kept for the lockfile. */
      readonly source: string;
      readonly ref: string;
      readonly subdir?: string | undefined;
    };

const GITHUB_SHORTHAND = /^github:([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/;

/**
 * Normalise a {@link PluginRef}: a `path` entry is local; a `source` entry is
 * git and must carry a `ref`.
 */
export function parsePluginRef(ref: PluginRef, pluginName: string): ParsedPluginRef {
  if ("path" in ref) {
    return { kind: "local", path: ref.path };
  }

  const { source, ref: gitRef, subdir } = ref;
  if (!gitRef) {
    throw new TackPluginError({
      message: `Plugin "${pluginName}" has a git source but no "ref" (tag, branch, or commit)`,
      pluginName
    });
  }

  return {
    kind: "git",
    cloneUrl: toCloneUrl(source, pluginName),
    source,
    ref: gitRef,
    ...(subdir ? { subdir: subdir.replace(/^\.?\/+/, "").replace(/\/+$/, "") } : {})
  };
}

function toCloneUrl(source: string, pluginName: string): string {
  const shorthand = GITHUB_SHORTHAND.exec(source);
  if (shorthand) {
    return `https://github.com/${shorthand[1]}/${shorthand[2]}.git`;
  }
  if (/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(source)) {
    return source;
  }
  throw new TackPluginError({
    message:
      `Plugin "${pluginName}" source "${source}" is not a recognised git reference ` +
      `(expected "github:owner/repo" or an https / ssh / file URL)`,
    pluginName
  });
}

/**
 * A stable, filesystem-safe slug for a git plugin's cache directory — derived
 * from the clone location (not the ref), so configs pointing at the same place
 * share a checkout. The commit is appended by the caller.
 */
export function slugForGitRef(ref: Extract<ParsedPluginRef, { kind: "git" }>): string {
  const key = `${ref.cloneUrl}::${ref.subdir ?? ""}`;
  const readable = ref.cloneUrl.replace(/^.*?:\/\/|\.git$|^git@/g, "").replace(/[^a-zA-Z0-9]+/g, "-");
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return `${readable}-${digest}`.replace(/^-+/, "").slice(0, 100);
}
