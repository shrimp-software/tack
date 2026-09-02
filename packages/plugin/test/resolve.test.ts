import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TackConfig } from "@cbxss/tack-core";

import { writeLock } from "../src/lock.js";
import { resolvePluginsIntoConfig } from "../src/resolve.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/acme-plugin/", import.meta.url));

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "tack-plugin-resolve-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("resolvePluginsIntoConfig", () => {
  it("returns a config with no plugins untouched", async () => {
    const config: TackConfig = { servers: { a: { transport: "stdio", command: "x" } } };
    expect(await resolvePluginsIntoConfig(config, { configDir: tmp })).toBe(config);
  });

  it("desugars a local plugin into a synthetic plugin source and drops `plugins`", async () => {
    const config: TackConfig = { servers: {}, plugins: { acme: { path: FIXTURE } } };

    const resolved = await resolvePluginsIntoConfig(config, { configDir: tmp });

    expect("plugins" in resolved).toBe(false);
    expect(resolved.servers["acme"]).toEqual({ transport: "plugin", path: FIXTURE });
  });

  it("anchors a relative local path to the config directory", async () => {
    await cp(FIXTURE, join(tmp, "vendor", "acme"), { recursive: true });
    const config: TackConfig = { servers: {}, plugins: { acme: { path: "./vendor/acme" } } };

    const resolved = await resolvePluginsIntoConfig(config, { configDir: tmp });
    expect(resolved.servers["acme"]).toEqual({
      transport: "plugin",
      path: join(tmp, "vendor", "acme")
    });
  });

  it("rejects a plugin whose name collides with a servers entry", async () => {
    const config: TackConfig = {
      servers: { acme: { transport: "stdio", command: "x" } },
      plugins: { acme: { path: FIXTURE } }
    };

    await expect(resolvePluginsIntoConfig(config, { configDir: tmp })).rejects.toThrow(/collides/);
  });

  it("rejects a git plugin that is not in the lockfile", async () => {
    const config: TackConfig = {
      servers: {},
      plugins: { acme: { source: "github:acme/tools", ref: "v1" } }
    };

    await expect(resolvePluginsIntoConfig(config, { configDir: tmp })).rejects.toThrow(
      /tack plugins add/
    );
  });

  it("rejects a git plugin whose config no longer matches its lock entry", async () => {
    await writeLock(join(tmp, "tack.plugins.lock"), {
      version: 1,
      plugins: {
        acme: { source: "github:acme/tools", ref: "v1", resolvedCommit: "a".repeat(40) }
      }
    });
    const config: TackConfig = {
      servers: {},
      plugins: { acme: { source: "github:acme/tools", ref: "v2" } }
    };

    await expect(resolvePluginsIntoConfig(config, { configDir: tmp })).rejects.toThrow(/does not match/);
  });

  it("checks out a git plugin pinned by the lockfile", async () => {
    const bare = await makeBareRepo(tmp);
    // (git clone/fetch — allow extra time)
    await writeLock(join(tmp, "tack.plugins.lock"), {
      version: 1,
      plugins: {
        acme: { source: bare.url, ref: "v1", resolvedCommit: bare.commit }
      }
    });

    const config: TackConfig = { servers: {}, plugins: { acme: { source: bare.url, ref: "v1" } } };

    const resolved = await resolvePluginsIntoConfig(config, { configDir: tmp });
    const entry = resolved.servers["acme"];
    expect(entry?.transport).toBe("plugin");
    expect((entry as { path: string }).path.startsWith(join(tmp, ".tack", "plugins"))).toBe(true);
  }, 20_000);
});

async function makeBareRepo(root: string): Promise<{ url: string; commit: string }> {
  const git = (args: string[], cwd: string): string =>
    execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();

  const work = join(root, "work");
  await cp(FIXTURE, work, { recursive: true });
  git(["init", "-q"], work);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], work);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], work);
  const commit = git(["rev-parse", "HEAD"], work);
  const bare = join(root, "repo.git");
  git(["clone", "-q", "--bare", work, bare], root);
  git(["tag", "v1", commit], bare);
  return { url: pathToFileURL(bare).href, commit };
}
