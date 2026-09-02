import { operationTypeBase, type TackOperation } from "@cbxss/tack-core";
import { compileSchema } from "@cbxss/tack-sdk-types";

/** Label threaded into `assertLocalSchemaRefs` errors from code-mode type compilation. */
const CONTEXT = { context: "described tool types" };

export interface OperationTypeScript {
  readonly typeBase: string;
  readonly inputTypeScript: string;
  readonly outputTypeScript?: string | undefined;
}

/**
 * Compile one operation's input (and, when it has an output schema, output)
 * JSON Schema into TypeScript. Shared by `describe.tool` and
 * `search({ namespace, types: true })` so a single operation is typed the same
 * way whichever route asked.
 */
export async function operationTypeScript(
  operation: TackOperation,
  options?: {
    readonly includeUnknownOutput?: boolean;
    /** What a schema-less output resolves to. `describe.tool` uses `"unknown"`;
     *  the typechecker uses `"any"` so `r.data.foo` isn't a false error. */
    readonly unknownOutputAs?: "unknown" | "any";
  }
): Promise<OperationTypeScript> {
  const typeBase = operationTypeBase(operation);
  const inputTypeScript = await compileSchema(operation.inputSchema, `${typeBase}Input`, CONTEXT);
  const outputTypeScript = operation.outputSchema
    ? await compileSchema(operation.outputSchema, `${typeBase}Output`, CONTEXT)
    : options?.includeUnknownOutput
      ? `export type ${typeBase}Output = ${options.unknownOutputAs ?? "unknown"};\n`
      : undefined;

  return {
    typeBase,
    inputTypeScript,
    ...(outputTypeScript ? { outputTypeScript } : {})
  };
}
