import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readLock, writeLock, withLockEntry, withoutLockEntry } from "../src/lock.js";

let tmp: string | undefined;
afterEach(async () => {
  if (tmp) {
    await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe("plugin lockfile", () => {
  it("round-trips through disk", async () => {
    tmp = await mkdtemp(join(tmpdir(), "tack-plugin-lock-"));
    const path = join(tmp, "tack.plugins.lock");

    expect(await readLock(path)).toEqual({ version: 1, plugins: {} });

    const lock = withLockEntry({ version: 1, plugins: {} }, "acme", {
      source: "github:acme/tools",
      ref: "v1.2.0",
      resolvedCommit: "a".repeat(40)
    });
    await writeLock(path, lock);

    const readBack = await readLock(path);
    expect(readBack.plugins["acme"]).toMatchObject({ ref: "v1.2.0", resolvedCommit: "a".repeat(40) });

    const removed = withoutLockEntry(readBack, "acme");
    expect(removed.plugins["acme"]).toBeUndefined();
  });
});
