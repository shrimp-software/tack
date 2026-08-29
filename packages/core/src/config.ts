import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { TackConfigError, TackIoError } from "./errors.js";
import { sanitizeData } from "./sanitize.js";
import {
  buildServerConfigSchema,
  resolveConfigPaths,
  type SourceKind
} from "./source-kind.js";
import { BUILTIN_SOURCE_KINDS } from "./source-kinds/index.js";
import type { TackConfig } from "./types.js";

const RateLimitConfigSchema = z.object({
  requests: z.number().int().positive(),
  windowMs: z.number().int().positive()
});

const configSchemaCache = new WeakMap<readonly SourceKind[], z.ZodType<TackConfig>>();

/** The full config schema for a given source-kind registry. Memoised per `kinds`
 *  array so the common (default) path parses without rebuilding. */
function buildConfigSchema(kinds: readonly SourceKind[]): z.ZodType<TackConfig> {
  const cached = configSchemaCache.get(kinds);
  if (cached) {
    return cached;
  }

  const schema = z.object({
    servers: z.record(z.string(), buildServerConfigSchema(kinds)).refine(
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
        maxToolResponseBytes: z.number().int().positive().optional(),
        maxInlineResultBytes: z.number().int().positive().optional()
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
      .optional(),
    delegate: z
      .object({
        model: z.string().min(1),
        apiKeyEnv: z.string().min(1).optional(),
        baseUrl: z.string().url().optional(),
        replans: z.number().int().min(0).max(3).optional()
      })
      .optional()
  }) satisfies z.ZodType<TackConfig>;

  configSchemaCache.set(kinds, schema);
  return schema;
}

export function parseConfig(
  input: unknown,
  kinds: readonly SourceKind[] = BUILTIN_SOURCE_KINDS
): TackConfig {
  const data = sanitizeData(input, { onCycle: "Cyclic Tack config data is not supported" });
  if (hasRemovedShapeConfig(data)) {
    throw new Error("config.shape was removed; Tack now infers operation paths automatically.");
  }
  return buildConfigSchema(kinds).parse(data);
}

function hasRemovedShapeConfig(input: unknown): boolean {
  return typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.prototype.hasOwnProperty.call(input, "shape");
}

async function loadJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (cause) {
    throw new TackIoError({ message: `Failed to read JSON from ${path}`, path, cause });
  }
}

async function loadConfig(path: string, kinds: readonly SourceKind[]): Promise<TackConfig> {
  const config = await loadParsedJson(
    path,
    (input) => parseConfig(input, kinds),
    (cause) => new TackConfigError({ message: `Invalid Tack config at ${path}`, cause })
  );
  return resolveConfigPaths(config, dirname(path), kinds);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch (cause) {
    throw new TackIoError({ message: `Failed to write JSON to ${path}`, path, cause });
  }
}

export function loadConfigPromise(
  path: string,
  kinds: readonly SourceKind[] = BUILTIN_SOURCE_KINDS
): Promise<TackConfig> {
  return loadConfig(path, kinds);
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
