import { toIdentifier } from "./ids.js";
import { ownDataEntries, ownDataRecord, ownDataValue as ownValue, ownDataValues } from "./own-data.js";
import {
  cloneJsonData,
  objectRecord as schemaRecord,
  schemaProperties
} from "./schema-data.js";
import type { JsonSchema, TackManifest, TackOperation } from "./types.js";

interface OperationVariant {
  readonly sdkName: string;
  readonly path: readonly string[];
  readonly inputSchema: JsonSchema;
  readonly injectedArgs?: Readonly<Record<string, string>>;
}

interface OperationTool {
  readonly id: string;
  readonly serverId: string;
  readonly namespaceName: string;
  readonly sdkName: string;
  readonly upstreamName: string;
  readonly description?: string | undefined;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema | undefined;
}

const SPLIT_DISCRIMINATORS = ["operation", "action"] as const;
const GENERIC_SPLIT_TOKENS = new Set(["call", "do", "execute", "manage", "perform", "run"]);
const LEADING_ACTION_TOKENS = new Set([
  "add",
  "create",
  "delete",
  "edit",
  "find",
  "get",
  "list",
  "patch",
  "read",
  "remove",
  "search",
  "set",
  "update",
  "write"
]);

export function listOperations(manifest: TackManifest): TackOperation[] {
  const usedPathsByServer = new Map<string, Set<string>>();
  const operations: TackOperation[] = [];
  const manifestRecord = schemaRecord(manifest);
  const manifestTools = schemaRecord(ownValue(manifestRecord, "tools"));
  const tools = ownDataValues<unknown>(manifestTools)
    .flatMap(toOperationTool)
    .sort(compareToolsForOperationPlanning);

  for (const tool of tools) {
    for (const variant of operationVariants(tool)) {
      const path = uniquePath(
        tool.namespaceName,
        variant.path,
        usedPathsByServer
      );
      const pathString = path.join(".");
      const operation: TackOperation = {
        path,
        pathString,
        fullPathString: `${tool.namespaceName}.${pathString}`,
        toolId: tool.id,
        serverId: tool.serverId,
        namespaceName: tool.namespaceName,
        sdkName: variant.sdkName,
        upstreamName: tool.upstreamName,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: variant.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        ...(variant.injectedArgs ? { injectedArgs: variant.injectedArgs } : {}),
        examples: []
      };

      operations.push({
        ...operation,
        examples: [operationExample(operation)]
      });
    }
  }

  return operations;
}

function toOperationTool(tool: unknown): OperationTool[] {
  const record = schemaRecord(tool);
  const id = ownValue<string>(record, "id");
  const serverId = ownValue<string>(record, "serverId");
  const namespaceName = ownValue<string>(record, "namespaceName");
  const sdkName = ownValue<string>(record, "sdkName");
  const upstreamName = ownValue<string>(record, "upstreamName");
  const inputSchema = ownValue<JsonSchema>(record, "inputSchema");
  const inputSchemaRecord = schemaRecord(inputSchema);
  if (
    typeof id !== "string" ||
    typeof serverId !== "string" ||
    typeof namespaceName !== "string" ||
    typeof sdkName !== "string" ||
    typeof upstreamName !== "string" ||
    !inputSchemaRecord
  ) {
    return [];
  }

  return [{
    id,
    serverId,
    namespaceName,
    sdkName,
    upstreamName,
    description: ownValue<string>(record, "description"),
    inputSchema: inputSchemaRecord,
    outputSchema: ownValue<JsonSchema>(record, "outputSchema")
  }];
}

function compareToolsForOperationPlanning(left: OperationTool, right: OperationTool): number {
  return (
    left.namespaceName.localeCompare(right.namespaceName) ||
    operationBasePath(left).localeCompare(operationBasePath(right)) ||
    left.id.localeCompare(right.id)
  );
}

function operationBasePath(tool: OperationTool): string {
  return inferOperationPath(tool).join(".");
}

export function findOperation(
  manifest: TackManifest,
  pathString: string
): TackOperation | undefined {
  return listOperations(manifest).find(
    (operation) =>
      operation.pathString === pathString || operation.fullPathString === pathString
  );
}

function operationExample(operation: TackOperation): string {
  return `await tools.${operation.fullPathString}(${hasRequiredInput(operation.inputSchema) ? "args" : ""})`;
}

export function operationArgs(operation: TackOperation, args: unknown): Record<string, unknown> {
  const base = ownDataRecord(args);
  const injectedArgs = ownValue<Readonly<Record<string, string>>>(operation, "injectedArgs");
  for (const [key, value] of ownDataEntries<string>(injectedArgs)) {
    base[key] = value;
  }
  return base;
}

export function hasRequiredInput(schema: JsonSchema): boolean {
  return schemaRequiresInput(schema);
}

function schemaRequiresInput(value: unknown, seen = new WeakSet<object>()): boolean {
  const schema = schemaRecord(value);
  if (!schema) {
    return false;
  }
  if (seen.has(schema)) {
    return false;
  }
  seen.add(schema);

  const required = schemaValue(schema, "required");
  if (Array.isArray(required) && ownDataValues<unknown>(required).length > 0) {
    return true;
  }

  const allOf = schemaValue(schema, "allOf");
  if (Array.isArray(allOf) && ownDataValues<unknown>(allOf).some((branch) => schemaRequiresInput(branch, seen))) {
    return true;
  }

  const oneOf = schemaValue(schema, "oneOf");
  const oneOfBranches = Array.isArray(oneOf) ? ownDataValues<unknown>(oneOf) : [];
  if (oneOfBranches.length === 1 && schemaRequiresInput(oneOfBranches[0], seen)) {
    return true;
  }

  const anyOf = schemaValue(schema, "anyOf");
  const anyOfBranches = Array.isArray(anyOf) ? ownDataValues<unknown>(anyOf) : [];
  return anyOfBranches.length > 0 &&
    anyOfBranches.every((branch) => schemaRequiresInput(branch, seen));
}

function schemaRequiresProperty(
  value: unknown,
  propertyName: string,
  seen = new WeakSet<object>()
): boolean {
  const schema = schemaRecord(value);
  if (!schema) {
    return false;
  }
  if (seen.has(schema)) {
    return false;
  }
  seen.add(schema);

  const required = schemaValue(schema, "required");
  if (
    Array.isArray(required) &&
    ownDataValues<unknown>(required).some((entry) => entry === propertyName)
  ) {
    return true;
  }

  const allOf = schemaValue(schema, "allOf");
  if (Array.isArray(allOf) && ownDataValues<unknown>(allOf).some((branch) => schemaRequiresProperty(branch, propertyName, seen))) {
    return true;
  }

  const oneOf = schemaValue(schema, "oneOf");
  if (Array.isArray(oneOf) && ownDataValues<unknown>(oneOf).some((branch) => schemaRequiresProperty(branch, propertyName, seen))) {
    return true;
  }

  const anyOf = schemaValue(schema, "anyOf");
  return Array.isArray(anyOf) &&
    ownDataValues<unknown>(anyOf).some((branch) => schemaRequiresProperty(branch, propertyName, seen));
}

function operationVariants(tool: OperationTool): OperationVariant[] {
  const splitBy = inferredSplitBy(tool.inputSchema);
  if (!splitBy) {
    const path = inferOperationPath(tool);
    return [{
      sdkName: path.at(-1) ?? tool.sdkName,
      path,
      inputSchema: tool.inputSchema
    }];
  }

  const splitValues = extractStringEnumValues(tool.inputSchema, splitBy);
  if (splitValues.length === 0) {
    const path = inferOperationPath(tool);
    return [{
      sdkName: path.at(-1) ?? tool.sdkName,
      path,
      inputSchema: tool.inputSchema
    }];
  }

  const basePath = inferSplitBasePath(tool);
  return splitValues.map((value) => ({
    sdkName: toIdentifier(value, "operation"),
    path: [...basePath, toIdentifier(value, "operation")],
    inputSchema: omitInputProperty(tool.inputSchema, splitBy, value),
    injectedArgs: { [splitBy]: value }
  }));
}

function inferredSplitBy(schema: JsonSchema): string | undefined {
  return SPLIT_DISCRIMINATORS.find((propertyName) =>
    schemaRequiresProperty(schema, propertyName) &&
    extractStringEnumValues(schema, propertyName).length > 0
  );
}

function inferOperationPath(tool: OperationTool): string[] {
  return inferredSplitBy(tool.inputSchema)
    ? inferSplitBasePath(tool)
    : inferUnsplitPath(tool);
}

function inferSplitBasePath(tool: OperationTool): string[] {
  const tokens = nameTokens(tool.upstreamName)
    .filter((token) => !GENERIC_SPLIT_TOKENS.has(token));
  return tokens.map((token) => toIdentifier(token, "group"));
}

function inferUnsplitPath(tool: OperationTool): string[] {
  const tokens = nameTokens(tool.upstreamName);
  const [action, ...resource] = tokens;
  if (action && LEADING_ACTION_TOKENS.has(action) && resource.length > 0) {
    const group = resource.length === 1 ? resource[0] : pluralizeToken(resource[0] ?? "resource");
    const leaf = [action, ...resource.slice(1)]
      .map((token, index) => index === 0 ? token : capitalizeIdentifierPart(token))
      .join("");
    return [
      toIdentifier(group ?? "resource", "group"),
      toIdentifier(leaf, "tool")
    ];
  }

  return [toIdentifier(tool.sdkName, "tool")];
}

function nameTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function pluralizeToken(token: string): string {
  if (token.endsWith("s")) {
    return token;
  }
  if (token.endsWith("y") && !/[aeiou]y$/.test(token)) {
    return `${token.slice(0, -1)}ies`;
  }
  return `${token}s`;
}

function capitalizeIdentifierPart(token: string): string {
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function uniquePath(
  serverName: string,
  path: readonly string[],
  usedPathsByServer: Map<string, Set<string>>
): string[] {
  const used = usedPathsByServer.get(serverName) ?? new Set<string>();
  usedPathsByServer.set(serverName, used);

  const unique = [...path];
  const bases = [...unique];
  const counters = unique.map(() => 2);
  let conflict = conflictingPath(unique, used);
  while (conflict || hasReservedCallableLeaf(unique)) {
    const suffixIndex = conflict
      ? conflictSuffixIndex(unique, conflict)
      : unique.length - 1;
    const base = bases[suffixIndex] ?? "tool";
    const counter = counters[suffixIndex] ?? 2;
    unique[suffixIndex] = `${base}${counter}`;
    counters[suffixIndex] = counter + 1;
    conflict = conflictingPath(unique, used);
  }

  used.add(unique.join("."));
  return unique;
}

function conflictingPath(path: readonly string[], used: ReadonlySet<string>): string[] | undefined {
  for (const key of used) {
    const existing = key.split(".");
    if (isPathPrefix(existing, path) || isPathPrefix(path, existing)) {
      return existing;
    }
  }
  return undefined;
}

function conflictSuffixIndex(path: readonly string[], conflict: readonly string[]): number {
  if (isPathPrefix(conflict, path)) {
    return conflict.length - 1;
  }
  return path.length - 1;
}

function isPathPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length &&
    prefix.every((segment, index) => segment === path[index]);
}

function hasReservedCallableLeaf(path: readonly string[]): boolean {
  return path.at(-1) === "then";
}

function extractStringEnumValues(schema: JsonSchema, propertyName: string): string[] {
  const values: string[] = [];
  const used = new Set<string>();
  collectDiscriminatorValues(schema, propertyName, values, used);
  return values;
}

function collectDiscriminatorValues(
  value: unknown,
  propertyName: string,
  values: string[],
  used: Set<string>,
  seen = new WeakSet<object>()
): void {
  const schema = schemaRecord(value);
  if (!schema) {
    return;
  }
  if (seen.has(schema)) {
    return;
  }
  seen.add(schema);

  addStringSchemaValues(schemaProperty(schema, propertyName), values, used, seen);

  for (const key of ["allOf", "anyOf", "oneOf"]) {
    const branches = schemaValue(schema, key);
    if (!Array.isArray(branches)) {
      continue;
    }

    for (const branch of ownDataValues<unknown>(branches)) {
      collectDiscriminatorValues(branch, propertyName, values, used, seen);
    }
  }
}

function addStringSchemaValues(
  value: unknown,
  values: string[],
  used: Set<string>,
  seen: WeakSet<object>
): void {
  const schema = schemaRecord(value);
  if (!schema) {
    return;
  }
  if (seen.has(schema)) {
    return;
  }
  seen.add(schema);

  addStringValue(schemaValue(schema, "const"), values, used);

  const enumValues = schemaValue(schema, "enum");
  if (Array.isArray(enumValues)) {
    for (const enumValue of ownDataValues<unknown>(enumValues)) {
      addStringValue(enumValue, values, used);
    }
  }

  for (const key of ["allOf", "anyOf", "oneOf"]) {
    const branches = schemaValue(schema, key);
    if (!Array.isArray(branches)) {
      continue;
    }

    for (const branch of ownDataValues<unknown>(branches)) {
      addStringSchemaValues(branch, values, used, seen);
    }
  }
}

function addStringValue(value: unknown, values: string[], used: Set<string>): void {
  if (typeof value !== "string" || used.has(value)) {
    return;
  }

  values.push(value);
  used.add(value);
}

function omitInputProperty(
  schema: JsonSchema,
  propertyName: string,
  propertyValue?: string
): JsonSchema {
  const next = cloneJsonData(schema, {
    cycleMessage: "Cyclic JSON Schema data is not supported"
  }) as JsonSchema;
  omitSchemaProperty(next, propertyName, propertyValue);
  return next;
}

function omitSchemaProperty(
  value: unknown,
  propertyName: string,
  propertyValue: string | undefined
): void {
  const schema = schemaRecord(value);
  if (!schema) {
    return;
  }

  const properties = schemaProperties(schema);
  if (properties) {
    delete properties[propertyName];
    if (Object.keys(properties).length === 0) {
      delete schema["properties"];
    }
  }

  removeStringArrayValue(schema, "required", propertyName);
  omitDependencyProperty(schema, propertyName, propertyValue);

  for (const key of [
    "additionalItems",
    "additionalProperties",
    "contains",
    "else",
    "if",
    "items",
    "not",
    "propertyNames",
    "then",
    "unevaluatedItems",
    "unevaluatedProperties"
  ]) {
    omitSchemaPropertyOrArray(schemaValue(schema, key), propertyName, propertyValue);
  }

  for (const key of ["allOf", "anyOf", "oneOf"]) {
    omitSchemaPropertyArray(schema, key, propertyName, propertyValue, true);
  }

  omitSchemaPropertyArray(schema, "prefixItems", propertyName, propertyValue, false);
}

function omitDependencyProperty(
  schema: Record<string, unknown>,
  propertyName: string,
  propertyValue: string | undefined
): void {
  const dependencies = schemaRecord(schemaValue(schema, "dependencies"));
  if (dependencies) {
    delete dependencies[propertyName];
    for (const [key, dependency] of Object.entries(dependencies)) {
      if (Array.isArray(dependency)) {
        const next = dependency.filter((value) => value !== propertyName);
        if (next.length > 0) {
          dependencies[key] = next;
        } else {
          delete dependencies[key];
        }
      } else {
        omitSchemaProperty(dependency, propertyName, propertyValue);
        if (isEmptySchemaRecord(dependency)) {
          delete dependencies[key];
        }
      }
    }
    if (Object.keys(dependencies).length === 0) {
      delete schema["dependencies"];
    }
  }

  const dependentRequired = schemaRecord(schemaValue(schema, "dependentRequired"));
  if (dependentRequired) {
    delete dependentRequired[propertyName];
    for (const [key, dependency] of Object.entries(dependentRequired)) {
      if (!Array.isArray(dependency)) {
        continue;
      }
      const next = dependency.filter((value) => value !== propertyName);
      if (next.length > 0) {
        dependentRequired[key] = next;
      } else {
        delete dependentRequired[key];
      }
    }
    if (Object.keys(dependentRequired).length === 0) {
      delete schema["dependentRequired"];
    }
  }

  const dependentSchemas = schemaRecord(schemaValue(schema, "dependentSchemas"));
  if (dependentSchemas) {
    delete dependentSchemas[propertyName];
    for (const [key, dependency] of Object.entries(dependentSchemas)) {
      omitSchemaProperty(dependency, propertyName, propertyValue);
      if (isEmptySchemaRecord(dependency)) {
        delete dependentSchemas[key];
      }
    }
    if (Object.keys(dependentSchemas).length === 0) {
      delete schema["dependentSchemas"];
    }
  }
}

function removeStringArrayValue(
  schema: Record<string, unknown>,
  key: string,
  propertyName: string
): void {
  const value = schemaValue(schema, key);
  if (Array.isArray(value)) {
    const required = value.filter((item) => item !== propertyName);
    if (required.length > 0) {
      schema[key] = required;
    } else {
      delete schema[key];
    }
  }
}

function omitSchemaPropertyOrArray(
  value: unknown,
  propertyName: string,
  propertyValue: string | undefined
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      omitSchemaProperty(item, propertyName, propertyValue);
    }
    return;
  }

  omitSchemaProperty(value, propertyName, propertyValue);
}

function omitSchemaPropertyArray(
  schema: Record<string, unknown>,
  key: string,
  propertyName: string,
  propertyValue: string | undefined,
  pruneEmpty: boolean
): void {
  const value = schemaValue(schema, key);
  if (!Array.isArray(value)) {
    return;
  }

  const next = [];
  let hasAlwaysTrueBranch = false;
  for (const item of value) {
    if (propertyValue !== undefined && schemaExcludesPropertyValue(item, propertyName, propertyValue)) {
      continue;
    }

    omitSchemaProperty(item, propertyName, propertyValue);
    if (!pruneEmpty || !isEmptySchemaRecord(item)) {
      next.push(item);
    } else if (key === "anyOf" || key === "oneOf") {
      hasAlwaysTrueBranch = true;
    }
  }

  if (hasAlwaysTrueBranch && key === "anyOf") {
    delete schema[key];
    return;
  }

  if (hasAlwaysTrueBranch && key === "oneOf" && next.length === 0) {
    delete schema[key];
    return;
  }

  if (next.length > 0) {
    schema[key] = next;
  } else {
    delete schema[key];
  }
}

function isEmptySchemaRecord(value: unknown): boolean {
  const schema = schemaRecord(value);
  return !!schema && Object.keys(schema).length === 0;
}

function schemaExcludesPropertyValue(
  value: unknown,
  propertyName: string,
  propertyValue: string
): boolean {
  const schema = schemaRecord(value);
  const propertySchema = schema ? schemaProperty(schema, propertyName) : undefined;
  if (propertySchema && schemaValueExcludesString(propertySchema, propertyValue)) {
    return true;
  }

  const allOf = schema ? schemaValue(schema, "allOf") : undefined;
  if (Array.isArray(allOf) && ownDataValues<unknown>(allOf).some((branch) =>
    schemaExcludesPropertyValue(branch, propertyName, propertyValue)
  )) {
    return true;
  }

  const anyOf = schema ? schemaValue(schema, "anyOf") : undefined;
  const anyOfBranches = Array.isArray(anyOf) ? ownDataValues<unknown>(anyOf) : [];
  if (
    anyOfBranches.length > 0 &&
    anyOfBranches.every((branch) => schemaExcludesPropertyValue(branch, propertyName, propertyValue))
  ) {
    return true;
  }

  const oneOf = schema ? schemaValue(schema, "oneOf") : undefined;
  const oneOfBranches = Array.isArray(oneOf) ? ownDataValues<unknown>(oneOf) : [];
  return oneOfBranches.length > 0 &&
    oneOfBranches.every((branch) => schemaExcludesPropertyValue(branch, propertyName, propertyValue));
}

function schemaValueExcludesString(value: unknown, propertyValue: string): boolean {
  const schema = schemaRecord(value);
  if (!schema) {
    return false;
  }

  const constValue = schemaValue(schema, "const");
  if (constValue !== undefined) {
    return constValue !== propertyValue;
  }

  const enumValues = schemaValue(schema, "enum");
  if (Array.isArray(enumValues)) {
    return !ownDataValues<unknown>(enumValues).includes(propertyValue);
  }

  const allOf = schemaValue(schema, "allOf");
  if (Array.isArray(allOf) && ownDataValues<unknown>(allOf).some((branch) => schemaValueExcludesString(branch, propertyValue))) {
    return true;
  }

  const anyOf = schemaValue(schema, "anyOf");
  const anyOfBranches = Array.isArray(anyOf) ? ownDataValues<unknown>(anyOf) : [];
  if (
    anyOfBranches.length > 0 &&
    anyOfBranches.every((branch) => schemaValueExcludesString(branch, propertyValue))
  ) {
    return true;
  }

  const oneOf = schemaValue(schema, "oneOf");
  const oneOfBranches = Array.isArray(oneOf) ? ownDataValues<unknown>(oneOf) : [];
  return oneOfBranches.length > 0 &&
    oneOfBranches.every((branch) => schemaValueExcludesString(branch, propertyValue));
}

function schemaProperty(schema: JsonSchema, propertyName: string): JsonSchema | undefined {
  return ownValue<JsonSchema>(schemaProperties(schema), propertyName);
}

function schemaValue(schema: Record<string, unknown>, key: string): unknown {
  return ownValue(schema, key);
}
