import type { TackConfig } from "@cbxss/tack-core";
import type { SearchInput, SearchResult, DescribedTool } from "@cbxss/tack-codemode";

export type TackOptions =
  | { readonly configPath?: string; readonly config?: never; readonly configDir?: never }
  | { readonly config: TackConfig; readonly configDir?: string; readonly configPath?: never };

export interface TackCallOptions {
  readonly signal?: AbortSignal | undefined;
  /** Deadline for this request, including its wait for shared initialization. */
  readonly timeoutMs?: number | undefined;
}

export interface TackResponse<T = unknown> {
  readonly ok: true;
  readonly data: T;
  readonly dataShape: unknown;
  readonly upstreamOutcome: "succeeded";
  /** Null in the direct SDK, which does not create a durable response store. */
  readonly responseId: string | null;
}

/** Project declarations augment this registry with config-path → tool-tree bindings. */
export interface TackConfigRegistry {}

type ToolsForPath<Path extends string> = string extends Path ? DynamicTools
  : [Path] extends [keyof TackConfigRegistry] ? TackConfigRegistry[Path & keyof TackConfigRegistry]
  : DynamicTools;

/** Only absent options or literal, registered paths acquire schema-specific types.
 * A supplied {} type can hide runtime selectors, so it must remain dynamic. */
export type TackToolsFor<Options extends TackOptions | undefined> = Options extends undefined
  ? ToolsForPath<"tack.config.json">
  : Options extends { readonly config: TackConfig } ? DynamicTools
  : Options extends { readonly configPath: infer Path extends string } ? ToolsForPath<Path>
  : DynamicTools;

export type TackArgs = Readonly<Record<string, unknown>>;
/** Null-prototype tool proxies expose no Object/Function or serialization members. */
export interface TackToolNamespace {
  readonly constructor: never;
  readonly toString: never;
  readonly toLocaleString: never;
  readonly valueOf: never;
  readonly hasOwnProperty: never;
  readonly isPrototypeOf: never;
  readonly propertyIsEnumerable: never;
  readonly __defineGetter__: never;
  readonly __defineSetter__: never;
  readonly __lookupGetter__: never;
  readonly __lookupSetter__: never;
  readonly __proto__: never;
  readonly bind: never;
  readonly call: never;
  readonly apply: never;
  readonly name: never;
  readonly length: never;
  readonly arguments: never;
  readonly caller: never;
  readonly prototype: never;
  readonly then: never;
  readonly toJSON: never;
}
/** A live callable keeps its signature without inheriting Function members. */
export type TackTool<Call extends (...args: never[]) => unknown> = Call & TackToolNamespace;
/** Dynamic paths are validated live. Returned data is deliberately unknown. */
export interface DynamicTool extends TackToolNamespace {
  (args?: TackArgs, options?: TackCallOptions): Promise<TackResponse>;
  readonly [segment: string]: DynamicTool;
}
export interface DynamicTools extends TackToolNamespace {
  readonly [namespace: string]: DynamicTool;
}

export type TackSearchInput = Omit<SearchInput, "types">;
export type TackSearchResult = SearchResult;
export type TackDescription = DescribedTool;
export type { TackConfig, UpstreamOutcome } from "@cbxss/tack-core";
