import { z } from "zod";

import type { TackManifestServer, TackServerConfig } from "./types.js";

/** The `transport` discriminant shared by {@link TackServerConfig} and
 *  {@link TackManifestServer}. */
export type Transport = TackServerConfig["transport"];

/** The manifest fields a source kind owns: every field on a manifest server
 *  except its `id` and its resolved tool list. */
export type ManifestServerConnection = Omit<TackManifestServer, "id" | "tools">;

/**
 * A kind of tool source as `@tack/core` sees it: the shape of one server config,
 * how that config projects into the manifest, and how relative paths in it are
 * anchored to the config file.
 *
 * The behavioural half — discovery and invocation — is the `Source` interface in
 * `@tack/sources`, which declares the `SourceKind`s it serves. Splitting the two
 * lets the leaf `@tack/core` own config/manifest shape without depending on the
 * source implementations.
 *
 * A first-party kind still adds its config interface + one arm on
 * {@link TackServerConfig} (and any new fields on {@link TackManifestServer}) in
 * `./types.ts` — TypeScript unions are static. That plus a `SourceKind` in
 * `./source-kinds/` is the whole core surface; `parseConfig`, `buildManifest`,
 * and `loadConfig` are all registry-driven.
 */
export interface SourceKind<TConfig extends TackServerConfig = TackServerConfig> {
  /** The `transport` discriminant of the configs this kind owns. */
  readonly transport: TConfig["transport"];
  /** Schema for one server config of this kind. Pins `transport` to a literal. */
  readonly configSchema: z.ZodType<TConfig>;
  /**
   * Project a config of this kind to its manifest connection fields. The config
   * is already sanitized (own data only), so this reads plain typed fields; it
   * returns `undefined` when a required field is missing — `buildManifest`
   * accepts hand-built configs that never passed `configSchema`.
   */
  connection(config: TConfig): ManifestServerConnection | undefined;
  /**
   * Anchor relative paths in the config to `baseDir` (the config file's
   * directory), returning a rewritten config. Return the input reference
   * unchanged when there is nothing to rewrite. Omit when this kind has no
   * path-valued fields.
   */
  resolvePaths?(config: TConfig, baseDir: string): TConfig;
}

const serverSchemaCache = new WeakMap<readonly SourceKind[], z.ZodType<TackServerConfig>>();

/**
 * A union schema over every registered kind's `configSchema`. Memoised per
 * `kinds` array so repeated `parseConfig` calls with the default registry don't
 * rebuild it.
 */
export function buildServerConfigSchema(
  kinds: readonly SourceKind[]
): z.ZodType<TackServerConfig> {
  const cached = serverSchemaCache.get(kinds);
  if (cached) {
    return cached;
  }

  const [first, ...rest] = kinds.map((kind) => kind.configSchema);
  if (!first) {
    throw new Error("buildServerConfigSchema requires at least one SourceKind");
  }

  const schema: z.ZodType<TackServerConfig> =
    rest.length === 0 ? first : z.union([first, ...rest]);
  serverSchemaCache.set(kinds, schema);
  return schema;
}

/** The kind that owns `transport`, or `undefined` when none is registered. */
export function sourceKindFor(
  kinds: readonly SourceKind[],
  transport: Transport
): SourceKind | undefined {
  return kinds.find((kind) => kind.transport === transport);
}

/**
 * Project one server config to its manifest connection fields via its kind.
 * Returns `undefined` when no registered kind owns the config's transport.
 */
export function manifestConnectionFor(
  kinds: readonly SourceKind[],
  config: TackServerConfig
): ManifestServerConnection | undefined {
  return sourceKindFor(kinds, config.transport)?.connection(config);
}

/**
 * Anchor relative paths in every server config to `baseDir` via each config's
 * kind. Returns the input `config` reference unchanged when nothing was
 * rewritten.
 */
export function resolveConfigPaths<
  TConfig extends { readonly servers: Readonly<Record<string, TackServerConfig>> }
>(config: TConfig, baseDir: string, kinds: readonly SourceKind[]): TConfig {
  let changed = false;
  const servers = Object.create(null) as Record<string, TackServerConfig>;

  for (const [id, server] of Object.entries(config.servers)) {
    const resolved = sourceKindFor(kinds, server.transport)?.resolvePaths?.(server, baseDir) ?? server;
    if (resolved !== server) {
      changed = true;
    }
    servers[id] = resolved;
  }

  return changed ? { ...config, servers } : config;
}
