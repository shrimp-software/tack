export type JsonSchema = Record<string, unknown>;
export type JsonObject = Record<string, unknown>;

export interface StdioServerConfig {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly inheritEnv?: boolean | undefined;
  readonly cwd?: string | undefined;
}

export interface HttpServerConfig {
  readonly transport: "http";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export interface ModuleServerConfig {
  readonly transport: "module";
  readonly entry: string;
}

/**
 * A plugin bundle mounted as one namespace. This is the *desugared* form: the
 * top-level {@link TackConfig.plugins} block is resolved (fetched / anchored) to
 * a local directory before it reaches config parsing, so by the time core sees a
 * `plugin` source it is always a plain `path`.
 */
export interface PluginServerConfig {
  readonly transport: "plugin";
  readonly path: string;
}

/**
 * One configured tool source. A first-party source kind adds its config
 * interface + one arm here (and any new fields on {@link TackManifestServer}),
 * then a `SourceKind` in `./source-kinds/` — TypeScript unions are static, so
 * this is the one type edit. Everything else (parsing, manifest projection,
 * path anchoring) is registry-driven off the `SourceKind`.
 */
export type TackServerConfig =
  | StdioServerConfig
  | HttpServerConfig
  | ModuleServerConfig
  | PluginServerConfig;

/**
 * A top-level {@link TackConfig.plugins} entry: either a git repo pinned to a
 * ref (resolved to a commit and cached under `.tack/plugins/`) or a local
 * directory used in place. `@cbxss/tack-plugin` resolves each of these into a
 * {@link PluginServerConfig} before discovery.
 */
export type PluginRef =
  | {
      readonly source: string;
      readonly ref: string;
      readonly subdir?: string | undefined;
    }
  | { readonly path: string };

export interface TackConfig {
  readonly servers: Readonly<Record<string, TackServerConfig>>;
  /**
   * Plugin bundles to mount, each as one namespace. Resolved by `@cbxss/tack-plugin`
   * into synthetic `plugin` sources (added to {@link TackConfig.servers}) before
   * discovery, so nothing downstream of `@cbxss/tack-sources` sees this field.
   */
  readonly plugins?: Readonly<Record<string, PluginRef>> | undefined;
  readonly runtime?: {
    readonly type?: "quickjs" | "workerd" | undefined;
    readonly timeoutMs?: number | undefined;
    readonly memoryMb?: number | undefined;
    readonly maxStackBytes?: number | undefined;
    readonly maxOutputBytes?: number | undefined;
    readonly maxToolCalls?: number | undefined;
    readonly maxToolRequestBytes?: number | undefined;
    readonly maxToolResponseBytes?: number | undefined;
    readonly maxInlineResultBytes?: number | undefined;
  } | undefined;
  readonly security?: {
    readonly allowedOperations?: readonly string[] | undefined;
    readonly deniedOperations?: readonly string[] | undefined;
    readonly auditLog?: {
      readonly path: string;
    } | undefined;
  } | undefined;
  readonly service?: {
    readonly host?: string | undefined;
    readonly port?: number | undefined;
    readonly maxRequestBytes?: number | undefined;
    readonly rateLimit?: RateLimitConfig | undefined;
    readonly users?: readonly ServiceUserConfig[] | undefined;
  } | undefined;
  readonly output?: {
    readonly dir?: string | undefined;
  } | undefined;
  readonly delegate?: {
    readonly model: string;
    readonly apiKeyEnv?: string | undefined;
    readonly baseUrl?: string | undefined;
    readonly replans?: number | undefined;
  } | undefined;
  /**
   * Pre-run typecheck of code-mode cells. On by default (`mode: "error"` blocks
   * a cell on any diagnostic); set `mode: "warn"` to attach diagnostics but run
   * anyway, or `mode: "off"` to disable.
   */
  readonly typecheck?: {
    readonly mode?: "error" | "warn" | "off" | undefined;
  } | undefined;
}

export interface RateLimitConfig {
  readonly requests: number;
  readonly windowMs: number;
}

export interface ServiceUserConfig {
  readonly id: string;
  readonly token: string;
  readonly allowedOperations?: readonly string[] | undefined;
  readonly deniedOperations?: readonly string[] | undefined;
  readonly rateLimit?: RateLimitConfig | undefined;
}

export interface TackManifestServer {
  readonly id: string;
  readonly transport: "stdio" | "http" | "module" | "plugin";
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly inheritEnv?: boolean | undefined;
  readonly cwd?: string | undefined;
  readonly url?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly entry?: string | undefined;
  /** Resolved absolute plugin root — `plugin` transport only (mirrors `entry`). */
  readonly pluginPath?: string | undefined;
  readonly tools: readonly string[];
}

export interface TackTool {
  readonly id: string;
  readonly serverId: string;
  readonly namespaceName: string;
  readonly sdkName: string;
  readonly upstreamName: string;
  readonly description?: string | undefined;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema | undefined;
  readonly annotations?: JsonObject | undefined;
  /**
   * Explicit, pre-segmented operation path. When set, {@link TackOperation}
   * planning uses it verbatim (one operation, no name inference, no
   * discriminator split). Used by plugin sources to place tools at
   * `mcp.<server>.<op>` / `<skill>`.
   */
  readonly path?: readonly string[] | undefined;
}

export interface TackOperation {
  readonly path: readonly string[];
  readonly pathString: string;
  readonly fullPathString: string;
  readonly toolId: string;
  readonly serverId: string;
  readonly namespaceName: string;
  readonly sdkName: string;
  readonly upstreamName: string;
  readonly description?: string | undefined;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema | undefined;
  readonly injectedArgs?: Readonly<Record<string, string>> | undefined;
  readonly examples: readonly string[];
}

export interface TackManifest {
  readonly version: "0.1";
  readonly generatedAt: string;
  readonly servers: Readonly<Record<string, TackManifestServer>>;
  readonly tools: Readonly<Record<string, TackTool>>;
}

export interface TackResult<TStructured = unknown> {
  readonly raw: unknown;
  readonly isError: boolean;
  readonly structuredContent: TStructured | undefined;
  text(): string;
  json<T = TStructured>(): T;
}

export interface TackRuntime {
  invoke<TStructured = unknown>(
    toolId: string,
    args: unknown
  ): Promise<TackResult<TStructured>>;
  close(): Promise<void>;
}
