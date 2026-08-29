import type {
  DiscoveredServer,
  SourceKind,
  TackConfig,
  TackRuntime,
  TackServerConfig,
  TackTool,
  Transport
} from "@tack/core";

/**
 * A kind of tool source. Register one in `dispatch.ts`'s `SOURCES` list and the
 * dispatcher fans discovery and invocation out to it — no per-transport branching.
 *
 * A `Source` is the behavioural half (discover + run); it declares the
 * {@link SourceKind}s it serves (config shape + manifest projection, owned by
 * `@tack/core`). The dispatcher hands each method only the slice this source owns
 * (entries / tools filtered by those kinds' transports), so implementations
 * never filter.
 *
 * Dependency-free kinds live in `src/sources/`; kinds with a real client or
 * protocol get their own `@tack/*` package (see `@tack/mcp`) and a thin adapter here.
 */
export interface Source {
  /** The `@tack/core` source kinds this source serves. */
  readonly kinds: readonly SourceKind[];

  /** Discover tools for this source's server configs. */
  discover(entries: readonly SourceServerEntry[]): Promise<DiscoveredServer[]>;

  /** Build an invoker for this source's tools. */
  createRuntime(input: SourceRuntimeInput): Promise<TackRuntime> | TackRuntime;
}

/** The `transport` discriminants a source owns, derived from its {@link Source.kinds}. */
export function sourceTransports(source: Source): readonly Transport[] {
  return source.kinds.map((kind) => kind.transport);
}

export type SourceServerEntry = readonly [serverId: string, config: TackServerConfig];

export interface SourceRuntimeInput {
  readonly config: TackConfig;
  readonly tools: readonly TackTool[];
}
