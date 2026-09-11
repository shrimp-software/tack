import { CODE_MODE_RESULT_TS } from "@cbxss/tack-core";

import { buildMethodTree, renderInterfaceTree, type MethodLike } from "./method-tree.js";

import { BUILTIN_CONTRACTS, builtinTypeScript, RESERVED_TOOL_KEYS } from "@cbxss/tack-core";

export const SEARCH_RESULT_TS = `type TackSearchResult = ${builtinTypeScript(BUILTIN_CONTRACTS.search.output)};\n`;
export const DESCRIBED_TOOL_TS = `type TackDescribedTool = ${builtinTypeScript(BUILTIN_CONTRACTS["describe.tool"].output)};\n`;

/**
 * The `declare global { const tools: {…}; function emit(…) } … export {};` block —
 * the part of the ambient surface that is identical between the generated
 * `tools.d.ts` (which prepends a header + `import type … from "./types.js"`) and
 * the typechecker's ambient lib (which prepends inline-compiled interfaces). The
 * per-operation `Input`/`Output` types are referenced by name only.
 */
export function renderAmbientToolsBlock(methods: readonly MethodLike[]): string {
  // Sort by full path so the output is deterministic regardless of caller order.
  const namespaced = methods
    .map((method) => ({ ...method, path: [method.namespaceName, ...method.path] }))
    .sort((left, right) => left.path.join(".").localeCompare(right.path.join(".")));
  const tree = buildMethodTree(namespaced);

  const reservedHits = [...tree.children.keys()].filter((key) => RESERVED_TOOL_KEYS.has(key));

  if (reservedHits.length) throw new Error(`Reserved tool namespace: ${reservedHits.join(", ")}`);
  const nested = new Map<string, string[]>();
  const builtins = ["call<T = unknown>(path: string, args?: Record<string, unknown>): Promise<CodeModeResult<T>>;"];
  for (const [path, contract] of Object.entries(BUILTIN_CONTRACTS)) {
    const [root, leaf] = path.split(".");
    const signature = `${leaf ?? root}(input: ${builtinTypeScript(contract.input)}): Promise<${builtinTypeScript(contract.output)}>;`;
    if (leaf) { const entries = nested.get(root!) ?? []; entries.push(signature); nested.set(root!, entries); }
    else builtins.push(signature);
  }
  for (const [root, entries] of nested) builtins.push(`${root}: { ${entries.join(" ")} };`);
  const chunks: string[] = [];

  chunks.push(
    "declare global {",
    "  const tools: {",
    ...renderInterfaceTree(tree, "    ", {
      result: (method) => `CodeModeResult<${method.outputType}>`
    }),
    ...builtins.map((line) => `    ${line}`),
    "  };",
    "  function emit(value: unknown): void;",
    "  /** Synchronous structural view of a value — no round trip. Use it to see a",
    "   *  downstream result's layout before writing code against it. */",
    "  function shape(value: unknown, maxDepth?: number): unknown;",
    "}",
    "",
    "export {};",
    ""
  );

  return chunks.join("\n");
}

export interface RenderToolsAmbientDtsOptions {
  /** Prepended verbatim as the first line (e.g. the generated-file header). */
  readonly header?: string | undefined;
}

/**
 * Render the ambient `declare const tools` `.d.ts` that types the code-mode
 * surface: every namespace's operations returning `CodeModeResult<Output>`,
 * plus `tools.call` / `tools.search` / `tools.describe.tool` and the free
 * `emit` function. Per-operation input/output types are referenced from a
 * sibling `./types.js` — this file is written next to the generated SDK's
 * `types.ts`, never served into an agent's context.
 */
export function renderToolsAmbientDts(
  methods: readonly MethodLike[],
  options: RenderToolsAmbientDtsOptions = {}
): string {
  const chunks: string[] = [];
  if (options.header) {
    chunks.push(options.header, "");
  }

  const typeNames = [
    ...new Set(methods.flatMap((method) => [method.inputType, method.outputType]))
  ].sort();
  if (typeNames.length > 0) {
    chunks.push(
      ["import type {", ...typeNames.map((name) => `  ${name},`), '} from "./types.js";', ""].join("\n")
    );
  }

  chunks.push(CODE_MODE_RESULT_TS.trim(), "", SEARCH_RESULT_TS.trim(), "", DESCRIBED_TOOL_TS.trim(), "");
  chunks.push(renderAmbientToolsBlock(methods));

  return chunks.join("\n");
}
