import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

import { TackConfigError, TackIoError } from "./errors.js";
import type { ModuleServerConfig, TackConfig, TackServerConfig } from "./types.js";

const StdioServerConfigSchema = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  inheritEnv: z.boolean().optional(),
  cwd: z.string().optional()
});

const HttpServerConfigSchema = z.object({
  transport: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional()
});

const ModuleServerConfigSchema = z.object({
  transport: z.literal("module"),
  entry: z.string().min(1)
});

const ServerConfigSchema = z.discriminatedUnion("transport", [
  StdioServerConfigSchema,
  HttpServerConfigSchema,
  ModuleServerConfigSchema
]);

const RateLimitConfigSchema = z.object({
  requests: z.number().int().positive(),
  windowMs: z.number().int().positive()
});

const TackConfigSchema = z.object({
  servers: z.record(z.string(), ServerConfigSchema).refine(
    (servers) => Object.keys(servers).length > 0,
    "At least one server is required"
  ),
  runtime: z
    .object({
      type: z.enum(["quickjs", "workerd"]).optional(),
      timeoutMs: z.number().int().positive().optional(),
      memoryMb: z.number().int().positive().optional(),
      maxStackBytes: z.number().int().positive().optional(),
      maxOutputBytes: z.number().int().positive().optional(),
      maxToolCalls: z.number().int().positive().optional(),
      maxToolRequestBytes: z.number().int().positive().optional(),
      maxToolResponseBytes: z.number().int().positive().optional()
    })
    .optional(),
  security: z
    .object({
      allowedOperations: z.array(z.string().min(1)).optional(),
      deniedOperations: z.array(z.string().min(1)).optional(),
      auditLog: z
        .object({
          path: z.string().min(1)
        })
        .optional()
    })
    .optional(),
  service: z
    .object({
      host: z.string().min(1).optional(),
      port: z.number().int().positive().max(65535).optional(),
      maxRequestBytes: z.number().int().positive().optional(),
      rateLimit: RateLimitConfigSchema.optional(),
      users: z
        .array(z.object({
          id: z.string().min(1),
          token: z.string().min(1),
          allowedOperations: z.array(z.string().min(1)).optional(),
          deniedOperations: z.array(z.string().min(1)).optional(),
          rateLimit: RateLimitConfigSchema.optional()
        }))
        .optional()
    })
    .optional(),
  output: z
    .object({
      dir: z.string().min(1).optional()
    })
    .optional()
}) satisfies z.ZodType<TackConfig>;

export function parseConfig(input: unknown): TackConfig {
  const data = cloneConfigData(input);
  if (hasRemovedShapeConfig(data)) {
    throw new Error("config.shape was removed; Tack now infers operation paths automatically.");
  }
  return TackConfigSchema.parse(data);
}

function hasRemovedShapeConfig(input: unknown): boolean {
  return typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.prototype.hasOwnProperty.call(input, "shape");
}

function cloneConfigData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (seen.has(value)) {
    throw new Error("Cyclic Tack config data is not supported");
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const array: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor?.enumerable && "value" in descriptor) {
          array[index] = cloneConfigData(descriptor.value, seen);
        }
      }
      return array;
    }

    const object: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        continue;
      }

      Object.defineProperty(object, key, {
        value: cloneConfigData(descriptor.value, seen),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return object;
  } finally {
    seen.delete(value);
  }
}

async function loadJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (cause) {
    throw new TackIoError({ message: `Failed to read JSON from ${path}`, path, cause });
  }
}

async function loadConfig(path: string): Promise<TackConfig> {
  const config = await loadParsedJson(path, parseConfig, (cause) =>
    new TackConfigError({ message: `Invalid Tack config at ${path}`, cause })
  );
  return resolveModuleEntries(config, dirname(path));
}

/**
 * Anchor relative module source `entry` paths to the config file's directory
 * rather than the current working directory. Returns the input unchanged when
 * there is nothing to rewrite.
 */
function resolveModuleEntries(config: TackConfig, baseDir: string): TackConfig {
  const entries = Object.entries(config.servers);
  if (!entries.some(([, server]) => needsAnchoring(server))) {
    return config;
  }

  const servers = Object.create(null) as Record<string, TackServerConfig>;
  for (const [id, server] of entries) {
    servers[id] = needsAnchoring(server)
      ? { ...server, entry: resolve(baseDir, server.entry) }
      : server;
  }

  return { ...config, servers };
}

/** A module source whose `entry` is relative and therefore needs anchoring to
 *  the config file's directory. */
function needsAnchoring(server: TackServerConfig): server is ModuleServerConfig {
  return server.transport === "module" && !isAbsolute(server.entry);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch (cause) {
    throw new TackIoError({ message: `Failed to write JSON to ${path}`, path, cause });
  }
}

export function loadConfigPromise(path: string): Promise<TackConfig> {
  return loadConfig(path);
}

export function writeJsonPromise(path: string, value: unknown): Promise<void> {
  return writeJson(path, value);
}

async function loadParsedJson<T, E>(
  path: string,
  parse: (input: unknown) => T,
  mapError: (cause: unknown) => E
): Promise<T> {
  const json = await loadJson(path);
  try {
    return parse(json);
  } catch (cause) {
    throw mapError(cause);
  }
}
