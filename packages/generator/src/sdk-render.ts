import {
  hasRequiredInput,
  propertyKey,
  typeSegment,
  type TackManifest
} from "@cbxss/tack-core";
import {
  argSignature,
  buildMethodTree,
  compileSchema,
  renderInterfaceTree,
  renderToolsAmbientDts,
  type MethodTree
} from "@cbxss/tack-sdk-types";

import {
  assertRuntimeManifestServerCoverage,
  assertSafeGeneratedServerNames,
  assertVisibleManifestToolsArePlannable
} from "./manifest-checks.js";
import { objectLiteralKey } from "./naming.js";
import {
  GENERATED_FILE_HEADER,
  SDK_RUNTIME_MANIFEST_GENERATED_AT,
  type GeneratedFile,
  type GeneratedMethod
} from "./types.js";

export async function renderSdkFiles(
  manifest: TackManifest,
  methods: readonly GeneratedMethod[],
  methodsByServer: ReadonlyMap<string, readonly GeneratedMethod[]>
): Promise<GeneratedFile[]> {
  assertSafeGeneratedServerNames(methodsByServer.keys());
  assertVisibleManifestToolsArePlannable(manifest);
  assertRuntimeManifestServerCoverage(manifest, methods);

  return [
    { fileName: "types.ts", contents: await renderTypes(methods) },
    { fileName: "index.ts", contents: renderIndex(manifest, methods, methodsByServer) },
    {
      fileName: "tools.d.ts",
      contents: renderToolsAmbientDts(methods, { header: GENERATED_FILE_HEADER })
    },
    ...[...methodsByServer.entries()].map(([serverName, serverMethods]) => ({
      fileName: `${serverName}.ts`,
      contents: renderServer(serverName, serverMethods)
    }))
  ];
}

/** Label for `assertLocalSchemaRefs` errors raised while compiling SDK types. */
const SDK_TYPES_CONTEXT = "generated SDK types";

async function renderTypes(methods: readonly GeneratedMethod[]): Promise<string> {
  const chunks = [
    GENERATED_FILE_HEADER,
    ""
  ];

  for (const method of methods) {
    chunks.push(await compileSchema(method.inputSchema, method.inputType, { context: SDK_TYPES_CONTEXT }));
    chunks.push(
      method.outputSchema
        ? await compileSchema(method.outputSchema, method.outputType, { context: SDK_TYPES_CONTEXT })
        : `export type ${method.outputType} = unknown;\n`
    );
    chunks.push(`export type ${method.resultType} = import("@cbxss/tack-core").TackResult<${method.outputType}>;\n`);
  }

  return `${chunks.join("\n").trim()}\n`;
}

function renderIndex(
  manifest: TackManifest,
  methods: readonly GeneratedMethod[],
  methodsByServer: ReadonlyMap<string, readonly GeneratedMethod[]>
): string {
  const servers = [...methodsByServer.keys()].map((name) => ({
    name,
    typeName: `${typeSegment(name)}Client`
  }));
  const imports = servers.map(
    (server) =>
      `import { create${server.typeName}, type ${server.typeName} } from "./${server.name}.js";`
  );
  const exports = servers.flatMap((server) => [
    `export { create${server.typeName} } from "./${server.name}.js";`,
    `export type { ${server.typeName} } from "./${server.name}.js";`
  ]);
  const clientProperties = servers.map(
    (server) => `  readonly ${propertyKey(server.name)}: ${server.typeName};`
  );

  return [
    GENERATED_FILE_HEADER,
    'import { DEFAULT_CONFIG_PATH, loadConfigPromise, type TackConfig, type TackManifest, type TackResult, type TackRuntime } from "@cbxss/tack-core";',
    ...imports,
    'export type * from "./types.js";',
    ...exports,
    "",
    `const manifest = JSON.parse(${JSON.stringify(JSON.stringify(toSdkRuntimeManifest(manifest, methods)))}) as TackManifest;`,
    "",
    "export interface CreateTackClientOptions {",
    "  readonly configPath?: string;",
    "  readonly config?: TackConfig;",
    "}",
    "",
    "export interface TackClient {",
    ...clientProperties,
    "  close(): Promise<void>;",
    "}",
    "",
    "export function createTackClientFromRuntime(runtime: TackRuntime): TackClient {",
    "  const clientRuntime = ownDataRuntime(runtime);",
    "  return {",
    ...servers.map((server) => `    ${propertyKey(server.name)}: create${server.typeName}(clientRuntime),`),
    "    close: () => clientRuntime.close()",
    "  };",
    "}",
    "",
    "export async function createTackClient(options: CreateTackClientOptions = {}): Promise<TackClient> {",
    "  const config = ownDataValue<TackConfig>(options, \"config\") ?? await loadConfigPromise(ownDataValue<string>(options, \"configPath\") ?? DEFAULT_CONFIG_PATH);",
    "  const { createRuntime } = await import(\"@cbxss/tack-sources\");",
    "  const runtime = await createRuntime({ config, manifest });",
    "  return createTackClientFromRuntime(runtime);",
    "}",
    "",
    "function ownDataValue<T>(value: unknown, key: PropertyKey): T | undefined {",
    "  if (typeof value !== \"object\" || value === null) {",
    "    return undefined;",
    "  }",
    "  const descriptor = Object.getOwnPropertyDescriptor(value, key);",
    "  return descriptor && \"value\" in descriptor ? descriptor.value as T : undefined;",
    "}",
    "",
    "function ownDataRuntime(runtime: TackRuntime): TackRuntime {",
    "  const invoke = ownDataValue<TackRuntime[\"invoke\"]>(runtime, \"invoke\");",
    "  const close = ownDataValue<TackRuntime[\"close\"]>(runtime, \"close\");",
    "  return {",
    "    invoke: <TStructured = unknown>(toolId: string, args: unknown): Promise<TackResult<TStructured>> => {",
    "      if (!invoke) {",
    "        return Promise.reject(new Error(\"Tack runtime invoke is required\"));",
    "      }",
    "      return invoke.call(runtime, toolId, args) as Promise<TackResult<TStructured>>;",
    "    },",
    "    close: (): Promise<void> => {",
    "      if (!close) {",
    "        return Promise.reject(new Error(\"Tack runtime close is required\"));",
    "      }",
    "      return close.call(runtime);",
    "    }",
    "  };",
    "}",
    ""
  ].join("\n");
}

function renderServer(
  serverName: string,
  methods: readonly GeneratedMethod[]
): string {
  const clientType = `${typeSegment(serverName)}Client`;
  const typeImports = methods.flatMap((method) => [
    method.inputType,
    method.outputType,
    method.resultType
  ]);
  const tree = buildMethodTree(methods);

  return [
    GENERATED_FILE_HEADER,
    'import type { TackResult, TackRuntime } from "@cbxss/tack-core";',
    renderTypeImport(typeImports),
    "",
    ...renderArgHelpers(methods),
    `export interface ${clientType} {`,
    ...renderInterfaceTree(tree, "  ", { result: (method) => method.resultType }),
    "}",
    "",
    `export function create${clientType}(runtime: TackRuntime): ${clientType} {`,
    "  const clientRuntime = ownDataRuntime(runtime);",
    "  return {",
    ...renderObjectTree(tree, "    "),
    "  };",
    "}",
    ""
  ].join("\n");
}

function renderArgHelpers(methods: readonly GeneratedMethod[]): string[] {
  if (methods.length === 0) {
    return [];
  }

  return [
    "function withInjectedArgs(args: unknown, injected: Readonly<Record<string, string>>): Record<string, unknown> {",
    "  const next = ownDataRecord(args);",
    "  for (const [key, value] of Object.entries(injected)) {",
    "    next[key] = value;",
    "  }",
    "  return next;",
    "}",
    "",
    "function ownDataRecord(value: unknown): Record<string, unknown> {",
    "  if (typeof value !== \"object\" || value === null || Array.isArray(value)) {",
    "    return Object.create(null) as Record<string, unknown>;",
    "  }",
    "  const next = Object.create(null) as Record<string, unknown>;",
    "  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {",
    "    if (descriptor.enumerable && \"value\" in descriptor) {",
    "      next[key] = descriptor.value;",
    "    }",
    "  }",
    "  return next;",
    "}",
    "",
    "function ownDataValue<T>(value: unknown, key: PropertyKey): T | undefined {",
    "  if (typeof value !== \"object\" || value === null) {",
    "    return undefined;",
    "  }",
    "  const descriptor = Object.getOwnPropertyDescriptor(value, key);",
    "  return descriptor && \"value\" in descriptor ? descriptor.value as T : undefined;",
    "}",
    "",
    "function ownDataRuntime(runtime: TackRuntime): TackRuntime {",
    "  const invoke = ownDataValue<TackRuntime[\"invoke\"]>(runtime, \"invoke\");",
    "  const close = ownDataValue<TackRuntime[\"close\"]>(runtime, \"close\");",
    "  return {",
    "    invoke: <TStructured = unknown>(toolId: string, args: unknown): Promise<TackResult<TStructured>> => {",
    "      if (!invoke) {",
    "        return Promise.reject(new Error(\"Tack runtime invoke is required\"));",
    "      }",
    "      return invoke.call(runtime, toolId, args) as Promise<TackResult<TStructured>>;",
    "    },",
    "    close: (): Promise<void> => {",
    "      if (!close) {",
    "        return Promise.reject(new Error(\"Tack runtime close is required\"));",
    "      }",
    "      return close.call(runtime);",
    "    }",
    "  };",
    "}",
    ""
  ];
}

function toSdkRuntimeManifest(
  manifest: TackManifest,
  methods: readonly GeneratedMethod[]
): TackManifest {
  const toolIds = new Set(methods.map((method) => method.toolId));
  const serverToolIds = new Map<string, string[]>();
  for (const method of methods) {
    const ids = serverToolIds.get(method.serverId) ?? [];
    ids.push(method.toolId);
    serverToolIds.set(method.serverId, ids);
  }

  return {
    version: manifest.version,
    generatedAt: SDK_RUNTIME_MANIFEST_GENERATED_AT,
    servers: Object.fromEntries(
      Object.entries(manifest.servers)
        .filter(([id]) => serverToolIds.has(id))
        .flatMap(([id, server]) => {
          const { id: serverId, transport, tools } = server;
          if (typeof serverId !== "string" || typeof transport !== "string" || !Array.isArray(tools)) {
            return [];
          }
          return [[
            id,
            {
              id: serverId,
              transport,
              tools: tools.filter(
                (toolId): toolId is string => typeof toolId === "string" && toolIds.has(toolId)
              )
            }
          ]];
        })
    ),
    tools: Object.fromEntries(
      Object.entries(manifest.tools)
        .filter(([id]) => toolIds.has(id))
        .flatMap(([id, tool]) => {
          const { id: toolId, serverId, namespaceName, sdkName, upstreamName } = tool;
          if (
            typeof toolId !== "string" ||
            typeof serverId !== "string" ||
            typeof namespaceName !== "string" ||
            typeof sdkName !== "string" ||
            typeof upstreamName !== "string"
          ) {
            return [];
          }
          return [[
            id,
            { id: toolId, serverId, namespaceName, sdkName, upstreamName, inputSchema: {} }
          ]];
        })
    )
  };
}

function renderTypeImport(typeNames: readonly string[]): string {
  if (typeNames.length === 0) {
    return "";
  }

  return [
    "import type {",
    ...typeNames.map((typeName) => `  ${typeName},`),
    '} from "./types.js";'
  ].join("\n");
}

function renderObjectTree(tree: MethodTree<GeneratedMethod>, indent: string): string[] {
  return [...tree.children.entries()].flatMap(([name, child]) => {
    if (child.method) {
      return [`${indent}${propertyKey(name)}: (${argSignature(child.method)}) => ${callExpression(child.method)},`];
    }

    return [
      `${indent}${propertyKey(name)}: {`,
      ...renderObjectTree(child, `${indent}  `),
      `${indent}},`
    ];
  });
}

function callExpression(method: GeneratedMethod): string {
  const argsExpression = hasRequiredInput(method.inputSchema) ? "args" : "args ?? {}";
  const finalArgs = method.injectedArgs
    ? `withInjectedArgs(${argsExpression}, { ${Object.entries(method.injectedArgs)
        .map(([key, value]) => `${objectLiteralKey(key)}: ${JSON.stringify(value)}`)
        .join(", ")} })`
    : `ownDataRecord(${argsExpression})`;

  return `clientRuntime.invoke<${method.outputType}>(${JSON.stringify(method.toolId)}, ${finalArgs})`;
}
