import type { JsonSchema } from "./types.js";
import { ownDataValue as ownValue } from "./own-data.js";

export interface CloneJsonDataOptions {
  readonly cycleMessage: string;
}

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function cloneJsonData(
  value: unknown,
  options: CloneJsonDataOptions,
  seen = new WeakSet<object>()
): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (seen.has(value)) {
    throw new Error(options.cycleMessage);
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const next: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor?.enumerable && "value" in descriptor) {
        next[index] = cloneJsonData(descriptor.value, options, seen);
      }
    }
    seen.delete(value);
    return next;
  }

  const next: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.enumerable && "value" in descriptor) {
      next[key] = cloneJsonData(descriptor.value, options, seen);
    }
  }
  seen.delete(value);
  return next;
}

export function stripTypeScriptSchemaExtensions(value: unknown): void {
  visitSchemaNodes(value, (schema) => {
    delete schema["tsType"];
    delete schema["tsEnumNames"];
  });
}

export function stripSchemaCompilerMetadata(value: unknown): void {
  visitSchemaNodes(value, (schema) => {
    delete schema["id"];
    delete schema["$id"];
    delete schema["title"];
    delete schema["description"];
    delete schema["markdownDescription"];
    delete schema["$comment"];
  });
}

export function assertLocalSchemaRefs(value: unknown, context: string): void {
  visitSchemaNodes(value, (schema) => {
    const ref = schema["$ref"];
    if (typeof ref === "string" && !ref.startsWith("#")) {
      throw new Error(`External JSON Schema refs are not supported in ${context}: ${ref}`);
    }
  });
}

export function pruneEmptySchemaCompositionArrays(value: unknown): void {
  visitSchemaNodes(value, (schema) => {
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      if (Array.isArray(schema[key]) && schema[key].length === 0) {
        delete schema[key];
      }
    }
  });
}

export function visitSchemaNodes(
  value: unknown,
  visit: (schema: Record<string, unknown>) => void
): void {
  const object = objectRecord(value);
  if (!object) {
    return;
  }

  visit(object);

  for (const key of [
    "$defs",
    "definitions",
    "properties",
    "patternProperties",
    "dependentSchemas",
    "dependencies"
  ]) {
    const schemas = objectRecord(object[key]);
    if (!schemas) {
      continue;
    }

    for (const schema of Object.values(schemas)) {
      visitSchemaNodes(schema, visit);
    }
  }

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
    visitSchemaNodeOrArray(object[key], visit);
  }

  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    visitSchemaNodeArray(object[key], visit);
  }
}

export function schemaProperties(schema: JsonSchema): Record<string, unknown> | undefined {
  return objectRecord(ownValue(schema, "properties"));
}

function visitSchemaNodeOrArray(
  value: unknown,
  visit: (schema: Record<string, unknown>) => void
): void {
  if (Array.isArray(value)) {
    visitSchemaNodeArray(value, visit);
    return;
  }

  visitSchemaNodes(value, visit);
}

function visitSchemaNodeArray(
  value: unknown,
  visit: (schema: Record<string, unknown>) => void
): void {
  if (!Array.isArray(value)) {
    return;
  }

  for (const item of value) {
    visitSchemaNodes(item, visit);
  }
}
