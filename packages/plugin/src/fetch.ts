import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { TackPluginError } from "@tack/core";

import type { ParsedPluginRef } from "./ref.js";
import { slugForGitRef } from "./ref.js";

const FULL_SHA = /^[0-9a-f]{40}$/i;

function git(args: readonly string[], cwd?: string): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          rejectPromise(
            new TackPluginError({ message: `git ${args.join(" ")} failed`, cause: error })
          );
          return;
        }
        resolvePromise(String(stdout).trim());
      }
    );
  });
}

/** Resolve a tag / branch / short sha to a full commit SHA. */
export async function resolveCommit(
  ref: Extract<ParsedPluginRef, { kind: "git" }>
): Promise<string> {
  if (FULL_SHA.test(ref.ref)) {
    return ref.ref.toLowerCase();
  }

  const out = await git(["ls-remote", ref.cloneUrl, ref.ref]);
  const sha = out.split(/\s+/)[0];
  if (!sha || !FULL_SHA.test(sha)) {
    throw new TackPluginError({
      message: `Could not resolve "${ref.ref}" in ${ref.cloneUrl} to a commit`
    });
  }
  return sha.toLowerCase();
}

export interface EnsureCheckoutInput {
  readonly ref: Extract<ParsedPluginRef, { kind: "git" }>;
  readonly commit: string;
  /** `.tack/plugins` — the cache root; the checkout goes in a slug@commit subdir. */
  readonly cacheRoot: string;
}

/**
 * Ensure a shallow checkout of `commit` exists under `cacheRoot`, and return the
 * plugin root (checkout dir + the ref's subdir). Idempotent: an existing
 * checkout at the right commit is reused untouched.
 */
export async function ensureCheckout({ ref, commit, cacheRoot }: EnsureCheckoutInput): Promise<string> {
  const dir = join(cacheRoot, `${slugForGitRef(ref)}@${commit}`);
  const root = ref.subdir ? join(dir, ref.subdir) : dir;

  if (!(await isCheckoutAt(dir, commit))) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await git(["init", "--quiet"], dir);
    await git(["remote", "add", "origin", ref.cloneUrl], dir);
    await git(["fetch", "--depth", "1", "--quiet", "origin", commit], dir).catch(() =>
      git(["fetch", "--depth", "1", "--quiet", "origin", ref.ref], dir)
    );
    await git(["checkout", "--quiet", "FETCH_HEAD"], dir);
    const actual = await git(["rev-parse", "HEAD"], dir);
    if (actual.toLowerCase() !== commit.toLowerCase()) {
      throw new TackPluginError({
        message: `Fetched ${actual} for ${ref.cloneUrl}@${ref.ref}, expected locked commit ${commit}`
      });
    }
  }

  if (ref.subdir && !(await exists(root))) {
    throw new TackPluginError({
      message: `Plugin subdir "${ref.subdir}" does not exist in ${ref.cloneUrl}@${commit}`
    });
  }
  return root;
}

async function isCheckoutAt(dir: string, commit: string): Promise<boolean> {
  try {
    return (await git(["rev-parse", "HEAD"], dir)).toLowerCase() === commit.toLowerCase();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
