import { compile } from "json-schema-to-typescript";
import {
  assertLocalSchemaRefs,
  dedupeName,
  objectRecord,
  pruneEmptySchemaCompositionArrays,
  sanitizeData,
  stripSchemaCompilerMetadata,
  stripTypeScriptSchemaExtensions,
  visitSchemaNodes,
  type JsonSchema
} from "@tack/core";

import { typeSegment } from "./naming.js";

export function compileSchema(schema: JsonSchema, typeName: string): Promise<string> {
  return compile(schemaForTypeScript(schema, typeName), typeName, {
    bannerComment: "",
    unknownAny: false
  });
}

function schemaForTypeScript(schema: JsonSchema, typeName: string): JsonSchema {
  const next = sanitizeData(schema, {}) as JsonSchema;
  normalizeLiteralRefData(next);
  stripTypeScriptSchemaExtensions(next);
  stripSchemaCompilerMetadata(next);
  pruneEmptySchemaCompositionArrays(next);
  assertLocalSchemaRefs(next, "generated SDK types");
  const { definitions, defs } = namespaceRootDefinitions(next, typeName);
  rewriteLocalDefinitionRefs(next, "definitions", definitions);
  rewriteLocalDefinitionRefs(next, "$defs", defs);
  return next;
}

function namespaceRootDefinitions(
  schema: JsonSchema,
  typeName: string
): {
  readonly definitions: ReadonlyMap<string, string>;
  readonly defs: ReadonlyMap<string, string>;
} {
  const definitions = objectRecord(schema["definitions"]);
  const defs = objectRecord(schema["$defs"]);
  const used = new Set<string>();
  const renamedDefinitions = new Map<string, string>();
  const renamedDefs = new Map<string, string>();
  const nextDefinitions: Record<string, unknown> = {};

  for (const [name, definition] of Object.entries(definitions ?? {})) {
    const nextName = dedupeName(`${typeName}${typeSegment(name)}`, used);
    renamedDefinitions.set(name, nextName);
    nextDefinitions[nextName] = definition;
  }

  for (const [name, definition] of Object.entries(defs ?? {})) {
    const nextName = dedupeName(`${typeName}${typeSegment(name)}`, used);
    renamedDefs.set(name, nextName);
    nextDefinitions[nextName] = definition;
  }

  delete schema["definitions"];
  if (renamedDefinitions.size > 0 || renamedDefs.size > 0) {
    schema["$defs"] = nextDefinitions;
  } else {
    delete schema["$defs"];
  }

  return { definitions: renamedDefinitions, defs: renamedDefs };
}

function rewriteLocalDefinitionRefs(
  value: unknown,
  key: "definitions" | "$defs",
  definitions: ReadonlyMap<string, string>
): void {
  if (definitions.size === 0) {
    return;
  }

  visitSchemaNodes(value, (schema) => {
    const ref = schema["$ref"];
    if (typeof ref === "string") {
      schema["$ref"] = rewriteDefinitionRef(ref, key, definitions);
    }
  });
}

function rewriteDefinitionRef(
  ref: string,
  key: "definitions" | "$defs",
  definitions: ReadonlyMap<string, string>
): string {
  const prefix = `#/${escapeJsonPointerSegment(key)}/`;
  if (!ref.startsWith(prefix)) {
    return ref;
  }

  const pointer = ref.slice(prefix.length).split("/");
  const [name, ...rest] = pointer;
  if (!name) {
    return ref;
  }

  const nextName = definitions.get(unescapeJsonPointerSegment(name));
  if (!nextName) {
    return ref;
  }

  return [
    "#/$defs/",
    escapeJsonPointerSegment(nextName),
    ...(rest.length > 0 ? [`/${rest.join("/")}`] : [])
  ].join("");
}

function normalizeLiteralRefData(value: unknown): void {
  visitSchemaNodes(value, (schema) => {
    const enumValues = schema["enum"];
    if (Array.isArray(enumValues) && enumValues.some(containsRefKey)) {
      delete schema["enum"];
      schema["oneOf"] = enumValues.map(literalValueSchema);
    }

    if ("const" in schema && containsRefKey(schema["const"])) {
      const literalSchema = literalValueSchema(schema["const"]);
      delete schema["const"];
      Object.assign(schema, literalSchema);
    }

    for (const key of ["default", "example", "examples"]) {
      if (containsRefKey(schema[key])) {
        delete schema[key];
      }
    }
  });
}

function containsRefKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsRefKey);
  }

  const object = objectRecord(value);
  if (!object) {
    return false;
  }

  return "$ref" in object || Object.values(object).some(containsRefKey);
}

function literalValueSchema(value: unknown): JsonSchema {
  if (value === null) {
    return { type: "null" };
  }

  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.map(literalValueSchema),
      additionalItems: false,
      minItems: value.length,
      maxItems: value.length
    };
  }

  const object = objectRecord(value);
  if (object) {
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(object).map(([key, child]) => [key, literalValueSchema(child)])
      ),
      required: Object.keys(object),
      additionalProperties: false
    };
  }

  return { const: value };
}

function escapeJsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapeJsonPointerSegment(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}
