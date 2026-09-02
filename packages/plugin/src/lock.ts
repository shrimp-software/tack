import { readFile, writeFile } from "node:fs/promises";

import { TackPluginError } from "@tack/core";

export interface PluginLockEntry {
  readonly source: string;
  readonly ref: string;
  readonly subdir?: string | undefined;
  readonly resolvedCommit: string;
}

export interface PluginLock {
  readonly version: 1;
  readonly plugins: Readonly<Record<string, PluginLockEntry>>;
}

/** Read `tack.plugins.lock`; a missing file is an empty lock. */
export async function readLock(path: string): Promise<PluginLock> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { version: 1, plugins: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new TackPluginError({ message: `Invalid ${path}: not JSON`, cause });
  }

  const record = parsed as { version?: unknown; plugins?: unknown };
  if (record?.version !== 1 || typeof record.plugins !== "object" || record.plugins === null) {
    throw new TackPluginError({ message: `Invalid ${path}: expected { version: 1, plugins: {} }` });
  }

  const plugins = Object.create(null) as Record<string, PluginLockEntry>;
  for (const [name, entry] of Object.entries(record.plugins as Record<string, unknown>)) {
    const value = (entry ?? {}) as Record<string, unknown>;
    const { source, ref, resolvedCommit, subdir } = value;
    if (
      typeof source !== "string" ||
      typeof ref !== "string" ||
      typeof resolvedCommit !== "string"
    ) {
      throw new TackPluginError({ message: `Invalid lock entry for plugin "${name}" in ${path}` });
    }
    plugins[name] = {
      source,
      ref,
      resolvedCommit,
      ...(typeof subdir === "string" ? { subdir } : {})
    };
  }

  return { version: 1, plugins };
}

export async function writeLock(path: string, lock: PluginLock): Promise<void> {
  const plugins = Object.fromEntries(
    Object.entries(lock.plugins).sort(([a], [b]) => a.localeCompare(b))
  );
  await writeFile(path, `${JSON.stringify({ version: 1, plugins }, null, 2)}\n`, "utf8");
}

export function withLockEntry(lock: PluginLock, name: string, entry: PluginLockEntry): PluginLock {
  return { version: 1, plugins: { ...lock.plugins, [name]: entry } };
}

export function withoutLockEntry(lock: PluginLock, name: string): PluginLock {
  const plugins = { ...lock.plugins };
  delete plugins[name];
  return { version: 1, plugins };
}
