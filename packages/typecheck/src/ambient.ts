import {
  assignOperationTypeNames,
  CODE_MODE_RESULT_TS,
  listOperations,
  type TackManifest,
  type TackOperation
} from "@cbxss/tack-core";
import {
  filterAllowedOperations,
  operationTypeScript,
  type OperationPolicy
} from "@cbxss/tack-codemode";
import {
  DESCRIBED_TOOL_TS,
  renderAmbientToolsBlock,
  SEARCH_RESULT_TS,
  type MethodLike
} from "@cbxss/tack-sdk-types";

/**
 * Globals the code-mode sandbox shadows to `undefined` (or a throwing stub).
 * Typing them `never` turns "you called `fetch`" into a crisp error instead of
 * a confusing property-access one.
 */
const SHADOW_DECLS = [
  "declare const fetch: never;",
  "declare const process: never;",
  "declare const require: never;",
  "declare const globalThis: never;",
  "declare const module: never;",
  "declare const self: never;",
  "declare const window: never;"
].join("\n");

/**
 * Build the self-contained ambient `.d.ts` the typechecker checks each cell
 * against: an inline `interface`/`type` for every policy-allowed operation's
 * input and output, the `CodeModeResult` / `TackSearchResult` / `TackDescribedTool`
 * aliases, the shadowed-globals declarations, and the `declare global { const
 * tools … ; function emit … }` block. Deterministic for a given manifest+policy;
 * built once per checker.
 *
 * Schema-less outputs resolve to `any` (not `unknown`) so `r.data.foo` on a
 * tool whose upstream gave no output schema isn't a false error.
 */
export async function buildAmbientDts(
  manifest: TackManifest,
  policy?: OperationPolicy
): Promise<string> {
  const operations = filterAllowedOperations(listOperations(manifest), policy);
  const typeNames = assignOperationTypeNames(operations);

  const interfaces: string[] = [];
  const methods: MethodLike[] = [];
  for (const operation of operations) {
    const names = typeNames.get(operation.fullPathString);
    if (!names) {
      continue;
    }
    const { inputTypeScript, outputTypeScript } = await operationTypeScript(operation, {
      includeUnknownOutput: true,
      unknownOutputAs: "any"
    });
    interfaces.push(inputTypeScript.trim());
    interfaces.push((outputTypeScript ?? `export type ${names.outputType} = any;`).trim());
    methods.push(toMethodLike(operation, names.inputType, names.outputType, names.resultType));
  }

  return [
    ...interfaces,
    "",
    CODE_MODE_RESULT_TS.trim(),
    "",
    SEARCH_RESULT_TS.trim(),
    "",
    DESCRIBED_TOOL_TS.trim(),
    "",
    SHADOW_DECLS,
    "",
    renderAmbientToolsBlock(methods)
  ].join("\n");
}

function toMethodLike(
  operation: TackOperation,
  inputType: string,
  outputType: string,
  resultType: string
): MethodLike {
  return {
    namespaceName: operation.namespaceName,
    path: operation.path,
    inputType,
    outputType,
    resultType,
    inputSchema: operation.inputSchema,
    ...(operation.outputSchema ? { outputSchema: operation.outputSchema } : {}),
    ...(operation.description ? { description: operation.description } : {}),
    examples: operation.examples,
    ...(operation.injectedArgs ? { injectedArgs: operation.injectedArgs } : {})
  };
}
