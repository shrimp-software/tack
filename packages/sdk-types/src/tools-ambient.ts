import { CODE_MODE_RESULT_TS } from "@tack/core";

import { buildMethodTree, renderInterfaceTree, type MethodLike } from "./method-tree.js";

/**
 * Namespace keys that would collide with a builtin on the `tools` object
 * (`tools.call`, `tools.search`, `tools.describe`, `emit` is a free function,
 * `then` is trapped to `undefined`). If a real namespace is named one of these
 * the builtin signature is dropped for that key and a `// note:` is emitted —
 * the namespace wins, matching runtime reality.
 */
const RESERVED_TOOL_KEYS: ReadonlySet<string> = new Set(["call", "search", "describe", "then", "emit"]);

/** The `TackSearchResult` alias referenced by the `tools.search` builtin signature. */
export const SEARCH_RESULT_TS =
  "type TackSearchResult = {\n" +
  "  items: Array<{ path: string; description?: string; params?: string[]; example: string; score?: number }>;\n" +
  "  total: number;\n" +
  "  hasMore: boolean;\n" +
  "  nextOffset: number | null;\n" +
  "};\n";

/** The `TackDescribedTool` alias referenced by the `tools.describe.tool` builtin signature. */
export const DESCRIBED_TOOL_TS =
  "type TackDescribedTool = {\n" +
  "  path: string;\n" +
  "  name: string;\n" +
  "  description?: string;\n" +
  "  inputSchema: unknown;\n" +
  "  outputSchema?: unknown;\n" +
  "  inputTypeScript: string;\n" +
  "  outputTypeScript?: string;\n" +
  "  typeScriptDefinitions?: string;\n" +
  "  examples: string[];\n" +
  "  error?: { code: string; message: string; suggestions: string[] };\n" +
  "};\n";

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

  const builtins: ReadonlyArray<{ key: string; line: string }> = [
    { key: "call", line: "call<T = unknown>(path: string, args?: Record<string, unknown>): Promise<CodeModeResult<T>>;" },
    {
      key: "search",
      line: "search(input?: { query?: string; namespace?: string; limit?: number; offset?: number }): Promise<TackSearchResult>;"
    },
    { key: "describe", line: "describe: { tool(input: { path: string; types?: boolean }): Promise<TackDescribedTool> };" }
  ];

  const chunks: string[] = [];
  if (reservedHits.length > 0) {
    chunks.push(
      `// note: namespace(s) ${reservedHits.map((key) => `\`${key}\``).join(", ")} shadow a \`tools\` builtin; ` +
        "the namespace wins and the builtin signature is omitted for that key."
    );
  }

  chunks.push(
    "declare global {",
    "  const tools: {",
    ...renderInterfaceTree(tree, "    ", {
      result: (method) => `CodeModeResult<${method.outputType}>`
    }),
    ...builtins
      .filter((builtin) => !reservedHits.includes(builtin.key))
      .map((builtin) => `    ${builtin.line}`),
    "  };",
    "  function emit(value: unknown): void;",
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
