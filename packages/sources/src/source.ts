import type {
  DiscoveredServer,
  TackConfig,
  TackManifestServer,
  TackRuntime,
  TackServerConfig,
  TackTool
} from "@tack/core";

/**
 * A kind of tool source. Register one in `dispatch.ts`'s `SOURCES` list and the
 * dispatcher fans discovery and invocation out to it — no per-transport branching.
 *
 * The dispatcher hands each method only the slice this source owns (entries /
 * tools filtered by {@link Source.transports}), so implementations never filter.
 *
 * Dependency-free kinds live in `src/sources/`; kinds with a real client or
 * protocol get their own `@tack/*` package (see `@tack/mcp`) and a thin adapter here.
 */
export interface Source {
  /** The `transport` discriminants of the server configs this source owns. */
  readonly transports: readonly TackManifestServer["transport"][];

  /** Discover tools for this source's server configs. */
  discover(entries: readonly SourceServerEntry[]): Promise<DiscoveredServer[]>;

  /** Build an invoker for this source's tools. */
  createRuntime(input: SourceRuntimeInput): Promise<TackRuntime> | TackRuntime;
}

export type SourceServerEntry = readonly [serverId: string, config: TackServerConfig];

export interface SourceRuntimeInput {
  readonly config: TackConfig;
  readonly tools: readonly TackTool[];
}
