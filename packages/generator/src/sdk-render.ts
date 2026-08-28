import {
  hasRequiredInput,
  objectRecord,
  ownDataEntries,
  ownDataValue as ownValue,
  ownDataValues,
  type TackManifest
} from "@tack/core";

import {
  assertRuntimeManifestServerCoverage,
  assertSafeGeneratedServerNames,
  assertVisibleManifestToolsArePlannable
} from "./manifest-checks.js";
import { objectLiteralKey, propertyKey, typeSegment } from "./naming.js";
import { compileSchema } from "./schema-types.js";
import {
  GENERATED_FILE_HEADER,
  SDK_RUNTIME_MANIFEST_GENERATED_AT,
  type GeneratedFile,
  type GeneratedMethod,
  type MethodTree
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
    ...[...methodsByServer.entries()].map(([serverName, serverMethods]) => ({
      fileName: `${serverName}.ts`,
      contents: renderServer(serverName, serverMethods)
    }))
  ];
}

async function renderTypes(methods: readonly GeneratedMethod[]): Promise<string> {
  const chunks = [
    GENERATED_FILE_HEADER,
    ""
  ];

  for (const method of methods) {
    chunks.push(await compileSchema(method.inputSchema, method.inputType));
    chunks.push(
      method.outputSchema
        ? await compileSchema(method.outputSchema, method.outputType)
        : `export type ${method.outputType} = unknown;\n`
    );
    chunks.push(`export type ${method.resultType} = import("@tack/core").TackResult<${method.outputType}>;\n`);
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
    'import { DEFAULT_CONFIG_PATH, loadConfigPromise, type TackConfig, type TackManifest, type TackResult, type TackRuntime } from "@tack/core";',
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
    "  const { createRuntime } = await import(\"@tack/sources\");",
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
    'import type { TackResult, TackRuntime } from "@tack/core";',
    renderTypeImport(typeImports),
    "",
    ...renderArgHelpers(methods),
    `export interface ${clientType} {`,
    ...renderInterfaceTree(tree, "  "),
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
      ownDataEntries<unknown>(manifest.servers)
        .filter(([id]) => serverToolIds.has(id))
        .flatMap(([id, server]) => {
          const record = objectRecord(server);
          const serverId = ownValue<string>(record, "id");
          const transport = ownValue<TackManifest["servers"][string]["transport"]>(record, "transport");
          const tools = ownValue<readonly string[]>(record, "tools");
          const toolIdsForServer = Array.isArray(tools)
            ? ownDataValues<unknown>(tools).filter((toolId): toolId is string => typeof toolId === "string")
            : [];
          return record && serverId && transport && Array.isArray(tools)
            ? [[
                id,
                {
                  id: serverId,
                  transport,
                  tools: toolIdsForServer.filter((toolId) => toolIds.has(toolId))
                }
              ]]
            : [];
        })
    ),
    tools: Object.fromEntries(
      ownDataEntries<unknown>(manifest.tools)
        .filter(([id]) => toolIds.has(id))
        .flatMap(([id, tool]) => {
          const record = objectRecord(tool);
          const toolId = ownValue<string>(record, "id");
          const serverId = ownValue<string>(record, "serverId");
          const namespaceName = ownValue<string>(record, "namespaceName");
          const sdkName = ownValue<string>(record, "sdkName");
          const upstreamName = ownValue<string>(record, "upstreamName");
          return record && toolId && serverId && namespaceName && sdkName && upstreamName
            ? [[
                id,
                {
                  id: toolId,
                  serverId,
                  namespaceName,
                  sdkName,
                  upstreamName,
                  inputSchema: {}
                }
              ]]
            : [];
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

function buildMethodTree(methods: readonly GeneratedMethod[]): MethodTree {
  const root: MethodTree = { children: new Map() };

  for (const method of methods) {
    let node = root;
    const parentPath: string[] = [];
    for (const segment of method.path) {
      if (node.method) {
        throw new Error(
          `Generated SDK path ${method.namespaceName}.${method.path.join(".")} nests under ` +
          `${method.namespaceName}.${parentPath.join(".")}. Inferred operation paths must not overlap.`
        );
      }

      const child = node.children.get(segment) ?? { children: new Map() };
      node.children.set(segment, child);
      node = child;
      parentPath.push(segment);
    }

    if (node.children.size > 0) {
      throw new Error(
        `Generated SDK path ${method.namespaceName}.${method.path.join(".")} is a prefix of another operation. ` +
        "Inferred operation paths must not overlap."
      );
    }
    node.method = method;
  }

  return root;
}

function renderInterfaceTree(tree: MethodTree, indent: string): string[] {
  return [...tree.children.entries()].flatMap(([name, child]) => {
    if (child.method) {
      return [
        ...renderJsDoc(child.method.description, child.method.examples, indent),
        `${indent}${propertyKey(name)}(${argSignature(child.method)}): Promise<${child.method.resultType}>;`
      ];
    }

    return [
      `${indent}readonly ${propertyKey(name)}: {`,
      ...renderInterfaceTree(child, `${indent}  `),
      `${indent}};`
    ];
  });
}

function renderObjectTree(tree: MethodTree, indent: string): string[] {
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

function argSignature(method: GeneratedMethod): string {
  return `${hasRequiredInput(method.inputSchema) ? "args" : "args?"}: ${method.inputType}`;
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

function renderJsDoc(
  description: string | undefined,
  examples: readonly string[],
  indent: string
): string[] {
  if (!description && examples.length === 0) {
    return [];
  }

  const lines = [
    ...(description ? jsDocTextLines(description, true) : []),
    ...(description && examples.length > 0 ? [""] : []),
    ...examples.flatMap((example) => ["@example", ...jsDocTextLines(example, true)])
  ];
  return [`${indent}/**`, ...lines.map((line) => `${indent} * ${line}`), `${indent} */`];
}

function jsDocTextLines(value: string, escapeTags: boolean): string[] {
  return value
    .replaceAll("*/", "* /")
    .split(/\r\n|\r|\n/)
    .map((line) => escapeTags && /^\s*@/u.test(line) ? line.replace("@", "\\@") : line);
}
