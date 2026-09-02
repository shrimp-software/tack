import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureCheckout, resolveCommit } from "../src/fetch.js";
import { parsePluginRef, type ParsedPluginRef } from "../src/ref.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/acme-plugin/", import.meta.url));

let tmp: string;
let bareUrl: string;
let commit: string;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8"
  }).trim();
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "tack-plugin-fetch-"));

  // A work tree seeded from the fixture, committed on `main` and tagged `v1`.
  const work = join(tmp, "work");
  await cp(FIXTURE, work, { recursive: true });
  git(["init", "-q"], work);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], work);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], work);
  commit = git(["rev-parse", "HEAD"], work);

  const bare = join(tmp, "repo.git");
  git(["clone", "-q", "--bare", work, bare], tmp);
  git(["tag", "v1", commit], bare);
  bareUrl = pathToFileURL(bare).href;
}, 20_000);

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function gitRef(ref: string): Extract<ParsedPluginRef, { kind: "git" }> {
  const parsed = parsePluginRef({ source: bareUrl, ref }, "acme");
  if (parsed.kind !== "git") {
    throw new Error("expected git");
  }
  return parsed;
}

describe("resolveCommit", () => {
  it("resolves a tag to its commit sha", async () => {
    expect(await resolveCommit(gitRef("v1"))).toBe(commit.toLowerCase());
  });

  it("returns a full sha unchanged", async () => {
    expect(await resolveCommit(gitRef(commit))).toBe(commit.toLowerCase());
  });

  it("throws for an unknown ref", async () => {
    await expect(resolveCommit(gitRef("does-not-exist"))).rejects.toThrow(/resolve/);
  });
});

describe("ensureCheckout", () => {
  it("checks out the commit and returns the plugin root", async () => {
    const cacheRoot = join(tmp, "cache");
    const root = await ensureCheckout({ ref: gitRef("v1"), commit, cacheRoot });

    expect(root.startsWith(cacheRoot)).toBe(true);
    expect((await stat(join(root, ".claude-plugin", "plugin.json"))).isFile()).toBe(true);
    expect(git(["rev-parse", "HEAD"], root)).toBe(commit);
  }, 20_000);

  it("is idempotent — a second call does not re-clone", async () => {
    const cacheRoot = join(tmp, "cache-idempotent");
    const first = await ensureCheckout({ ref: gitRef("v1"), commit, cacheRoot });
    const before = (await stat(first)).mtimeMs;
    const second = await ensureCheckout({ ref: gitRef("v1"), commit, cacheRoot });
    expect(second).toBe(first);
    expect((await stat(second)).mtimeMs).toBe(before);
  }, 20_000);

  it("rejects a fallback fetch that does not produce the locked commit", async () => {
    await expect(ensureCheckout({
      ref: gitRef("v1"),
      commit: "a".repeat(40),
      cacheRoot: join(tmp, "cache-wrong-commit")
    })).rejects.toThrow(/expected locked commit/);
  }, 20_000);
});
