import { mkdir, lstat } from "node:fs/promises";
import { dirname } from "node:path";

export interface StateStatement {
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
  run(...parameters: unknown[]): unknown;
}

export interface StateDatabase {
  exec(sql: string): void;
  prepare(sql: string): StateStatement;
  close(): void;
}

export async function ensureStateDirectory(databasePath: string): Promise<void> {
  const directory = dirname(databasePath);
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("state_directory_unsafe");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("state_directory_unsafe");
  }
}

export async function openStateDatabase(databasePath: string): Promise<StateDatabase> {
  await ensureStateDirectory(databasePath);
  const isBun = typeof process !== "undefined" && typeof process.versions?.bun === "string";
  if (isBun) {
    const module = await import("bun:sqlite");
    const database = new module.Database(databasePath);
    return {
      exec: (sql) => database.exec(sql),
      prepare: (sql) => database.query(sql),
      close: () => database.close()
    };
  }
  const module = await import("node:sqlite");
  const database = new module.DatabaseSync(databasePath);
  return database as unknown as StateDatabase;
}

export function configureStateDatabase(database: StateDatabase, busyTimeoutMs: number): void {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs <= 0 || busyTimeoutMs > 5_000) throw new Error("busy_timeout_exceeds_hard_cap");
  database.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs};`);
}

export function beginImmediate(database: StateDatabase): void {
  database.exec("BEGIN IMMEDIATE;");
}

export function commit(database: StateDatabase): void {
  database.exec("COMMIT;");
}

export function rollback(database: StateDatabase): void {
  try { database.exec("ROLLBACK;"); } catch { /* the connection may already be closed after a native error */ }
}
