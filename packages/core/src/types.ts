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

export type TackServerConfig = StdioServerConfig | HttpServerConfig;

export interface TackConfig {
  readonly servers: Readonly<Record<string, TackServerConfig>>;
  readonly runtime?: {
    readonly type?: "quickjs" | "workerd" | undefined;
    readonly timeoutMs?: number | undefined;
    readonly memoryMb?: number | undefined;
    readonly maxStackBytes?: number | undefined;
    readonly maxOutputBytes?: number | undefined;
    readonly maxToolCalls?: number | undefined;
    readonly maxToolRequestBytes?: number | undefined;
    readonly maxToolResponseBytes?: number | undefined;
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
  readonly transport: "stdio" | "http";
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly inheritEnv?: boolean | undefined;
  readonly cwd?: string | undefined;
  readonly url?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
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
