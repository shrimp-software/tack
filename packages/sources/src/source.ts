import type {
  DiscoveredServer,
  TackConfig,
  TackManifest,
  TackManifestServer,
  TackRuntime
} from "@tack/core";

/**
 * A kind of tool source. Register one in `dispatch.ts`'s `SOURCES` list and the
 * dispatcher fans discovery and invocation out to it — no per-transport branching.
 *
 * Dependency-free kinds live in `src/sources/`; kinds with a real client or
 * protocol get their own `@tack/*` package (see `@tack/mcp`) and a thin adapter here.
 */
export interface Source {
  /** The `transport` discriminants of the server configs this source owns. */
  readonly transports: readonly TackManifestServer["transport"][];

  /** Discover tools for this source's server configs. Other transports are ignored. */
  discover(config: TackConfig): Promise<DiscoveredServer[]>;

  /**
   * Build an invoker for this source's tools. Receives the full manifest and
   * serves only the tools whose server it owns; the dispatcher routes by
   * transport, so foreign tools never reach it.
   */
  createRuntime(input: SourceRuntimeInput): Promise<TackRuntime> | TackRuntime;
}

export interface SourceRuntimeInput {
  readonly config: TackConfig;
  readonly manifest: TackManifest;
}
