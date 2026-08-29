import {
  assertLocalSchemaRefs,
  findOperation,
  ownField,
  pruneEmptySchemaCompositionArrays,
  sanitizeData,
  stripSchemaCompilerMetadata,
  stripTypeScriptSchemaExtensions,
  type JsonSchema,
  type TackManifest,
  type TackOperation
} from "@tack/core";
import { compile } from "json-schema-to-typescript";

import { isOperationAllowed, type OperationPolicy } from "./policy.js";
import { searchOperations } from "./search.js";

export interface DescribeToolInput {
  readonly path: string;
  /** Include `outputTypeScript` + the bundled `typeScriptDefinitions` blob. */
  readonly types?: boolean | undefined;
}

export type DescribeToolResult = DescribedTool | ToolNotFoundDescription;

export interface DescribedTool {
  readonly path: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema | undefined;
  readonly inputTypeScript: string;
  /** Only when the tool has an output schema, or `types: true` was passed. */
  readonly outputTypeScript?: string | undefined;
  /** Only when `types: true` was passed — input + output + a `ToolResult<T>` alias. */
  readonly typeScriptDefinitions?: string | undefined;
  readonly examples: readonly string[];
  readonly injectedArgs?: Readonly<Record<string, string>> | undefined;
}

export interface ToolNotFoundDescription {
  readonly path: string;
  readonly name: string;
  readonly error: {
    readonly code: "tool_not_found";
    readonly message: string;
    readonly suggestions: readonly string[];
  };
}

export function normalizeDescribeToolInput(input: unknown): DescribeToolInput {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const path = ownField<unknown>(input, "path");
    if (typeof path === "string") {
      return { path, ...(ownField<unknown>(input, "types") === true ? { types: true } : {}) };
    }
  }

  return { path: "" };
}

export async function describeTool(
  manifest: TackManifest,
  input: DescribeToolInput,
  policy?: OperationPolicy
): Promise<DescribeToolResult> {
  const operation = findOperation(manifest, input.path);
  if (!operation || !isOperationAllowed(operation, policy).allowed) {
    return notFoundDescription(manifest, input.path, policy);
  }

  const inputTypeName = typeName(operation, "Input");
  const outputTypeName = typeName(operation, "Output");
  const inputTypeScript = await compileSchema(operation.inputSchema, inputTypeName);
  // Only compile an output type when there's a real schema, or the caller asked
  // for the full type bundle. Otherwise it's just `export type X = unknown;`.
  const outputTypeScript = operation.outputSchema
    ? await compileSchema(operation.outputSchema, outputTypeName)
    : input.types
      ? `export type ${outputTypeName} = unknown;\n`
      : undefined;

  return {
    path: operation.fullPathString,
    name: operation.sdkName,
    ...(operation.description ? { description: operation.description } : {}),
    inputSchema: operation.inputSchema,
    ...(operation.outputSchema ? { outputSchema: operation.outputSchema } : {}),
    inputTypeScript,
    ...(outputTypeScript ? { outputTypeScript } : {}),
    ...(input.types
      ? {
          typeScriptDefinitions: [
            inputTypeScript.trim(),
            (outputTypeScript ?? `export type ${outputTypeName} = unknown;`).trim(),
            `type ToolResult<T> = { ok: true; data: T; text: string; raw?: unknown } | { ok: false; error: { message: string }; text: string; raw?: unknown };`
          ].join("\n\n")
        }
      : {}),
    examples: operation.examples,
    ...(operation.injectedArgs ? { injectedArgs: operation.injectedArgs } : {})
  };
}

function notFoundDescription(
  manifest: TackManifest,
  path: string,
  policy?: OperationPolicy
): ToolNotFoundDescription {
  const leaf = path.split(".").at(-1) ?? path;
  const suggestions = searchOperations(manifest, {
    query: leaf,
    limit: 5
  }, policy).items.map((item) => item.path);

  return {
    path,
    name: path,
    error: {
      code: "tool_not_found",
      message: `Tool not found: ${path}`,
      suggestions
    }
  };
}

async function compileSchema(schema: JsonSchema, typeName: string): Promise<string> {
  return compile(schemaForTypeScript(schema) as JsonSchema, typeName, {
    bannerComment: "",
    unknownAny: false
  });
}

function schemaForTypeScript(schema: JsonSchema): JsonSchema {
  const next = sanitizeData(schema, {}) as JsonSchema;
  stripTypeScriptSchemaExtensions(next);
  stripSchemaCompilerMetadata(next);
  pruneEmptySchemaCompositionArrays(next);
  assertLocalSchemaRefs(next, "described tool types");
  return next;
}

function typeName(operation: TackOperation, suffix: string): string {
  return `${operation.fullPathString
    .split(".")
    .flatMap((segment) => segment.match(/[A-Z]+(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|\d+/g) ?? [segment])
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("")}${suffix}`;
}
