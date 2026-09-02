import {
  CODE_MODE_RESULT_TS,
  findOperation,
  ownField,
  type JsonSchema,
  type TackManifest
} from "@cbxss/tack-core";

import { operationTypeScript } from "./operation-typescript.js";
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
  /** Only when `types: true` was passed — input + output + a `CodeModeResult<T>` alias. */
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

  // Only compile an `unknown` output alias when the caller asked for the full
  // type bundle; otherwise `outputTypeScript` stays absent for a schema-less tool.
  const { typeBase, inputTypeScript, outputTypeScript } = await operationTypeScript(operation, {
    includeUnknownOutput: input.types === true
  });
  const outputTypeName = `${typeBase}Output`;

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
            CODE_MODE_RESULT_TS.trim()
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
