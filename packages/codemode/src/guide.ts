import { listOperations, type TackManifest } from "@tack/core";

import { filterAllowedOperations, type OperationPolicy } from "./policy.js";

export const TOOL_INVENTORY_HEADER = "## Available namespaces";
export const EXECUTE_GUIDE_NAME = "execute";

export interface ExecutionGuide {
  readonly name: string;
  readonly summary: string;
  readonly body: string;
}

/**
 * The always-loaded `execute` tool description. Kept lean on purpose — every
 * session pays for it up front — so it carries only the live namespace
 * inventory plus a pointer to the full how-to behind the `guide` tool.
 */
export function createExecuteDescription(
  manifest: TackManifest,
  policy?: OperationPolicy | undefined
): string {
  const lines = [
    "Run TypeScript in Tack's sandboxed runtime against your connected API tools.",
    "Scope persists across `execute` calls; `{ fresh: true }` starts a clean scope.",
    "",
    'Call `guide({ name: "execute" })` for the how-to: discovering tools, calling them,',
    "`emit`/`return`, refs, and file outputs."
  ];
  const inventory = renderNamespaceInventory(manifest, policy);
  if (inventory.length > 0) {
    lines.push("", inventory);
  }
  return lines.join("\n");
}

export function renderGuideIndex(): string {
  return [
    "Guides hold the long-form how-to that would otherwise bloat a tool's always-loaded description.",
    "",
    `- \`${EXECUTE_GUIDE_NAME}\` — writing code for the \`execute\` tool.`
  ].join("\n");
}

export function findGuide(
  name: string,
  manifest: TackManifest,
  policy?: OperationPolicy | undefined
): ExecutionGuide | undefined {
  if (name.trim() !== EXECUTE_GUIDE_NAME) {
    return undefined;
  }
  return {
    name: EXECUTE_GUIDE_NAME,
    summary: "Discover tools, call them, emit results, and work with refs in the execute sandbox.",
    body: renderExecuteGuide(manifest, policy)
  };
}

/** The full `execute` how-to, served on demand by the `guide` tool. */
export function renderExecuteGuide(
  manifest: TackManifest,
  policy?: OperationPolicy | undefined
): string {
  return [
    "# execute",
    "",
    "## Workflow",
    "",
    "1. `tools.search({})` lists namespaces; `tools.search({ namespace })` lists a namespace's",
    "   operations with descriptions + `params` (required input keys); `tools.search({ query })`",
    "   keyword-searches across everything.",
    "2. `tools.describe.tool({ path })` for the full input schema when `params` isn't enough",
    "   (`{ types: true }` adds TypeScript defs). A bad path returns `error.suggestions` — use one.",
    "3. Call via `tools.<namespace>.<...>(args)` or `tools.call(path, args)`. Await every call.",
    "   Don't pass discriminator fields Tack already injects.",
    "4. `emit(value)` appends user-visible output; `return value` is the model-readable final result.",
    "",
    "## Rules",
    "",
    "- A tool call returns `{ ok: true, data }` or `{ ok: false, error: { message } }` — branch on `ok`.",
    "- Scope persists across cells: top-level `const`/`let`/`function`/`class` and reassignments",
    "  carry to the next `execute` call. `{ fresh: true }` resets it.",
    "- A large returned/emitted value comes back as `{ __tackRef: \"$1\", type, preview }` — use `$1`",
    "  (or `$_` for the last) as a normal variable in the next cell, or `deref({ ref: \"$1\", offset?, limit? })`.",
    "- Filter large collections in code rather than calling a per-item tool in a loop.",
    "- No `fetch` — all API calls go through `tools.*`. TypeScript type syntax is stripped before",
    "  execution; `enum` and decorators are not supported.",
    "- `emit` forwards MCP content blocks as-is; a `{ _tag: \"ToolFile\", mimeType, encoding: \"base64\",",
    "  data, byteLength, name? }` renders by MIME (image/audio/text/resource). `return` is for ordinary",
    "  structured data only — not files, base64, or content blocks.",
    "- Previews truncate at 30000 chars; emitted text files at 64000.",
    "",
    "## Example",
    "",
    "```ts",
    "const { items } = await tools.search({ namespace: \"grafana\", query: \"list datasources\" });",
    "const result = await tools.call(items[0].path, {});",
    "return result.ok ? result.data : result.error;",
    "```",
    "",
    renderNamespaceInventory(manifest, policy)
  ].join("\n");
}

export function availableNamespaces(
  manifest: TackManifest,
  policy: OperationPolicy | undefined
): readonly string[] {
  return [...new Set(
    filterAllowedOperations(listOperations(manifest), policy)
      .map((operation) => operation.namespaceName)
  )].sort();
}

function renderNamespaceInventory(
  manifest: TackManifest,
  policy: OperationPolicy | undefined
): string {
  const namespaces = availableNamespaces(manifest, policy);
  if (namespaces.length === 0) {
    return "";
  }

  return [
    TOOL_INVENTORY_HEADER,
    "",
    "Namespaces you have connected. Their tools live under `tools.<namespace>...`.",
    ...namespaces.map((namespace) => `- \`${namespace}\``)
  ].join("\n");
}
