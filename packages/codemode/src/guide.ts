import { listOperations, type TackManifest } from "@tack/core";

import { filterAllowedOperations, type OperationPolicy } from "./policy.js";

export const EXECUTE_GUIDE_NAME = "execute";
export const TOOL_INVENTORY_HEADER = "## Available namespaces";

export interface ExecutionGuide {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export function createExecuteDescription(
  manifest: TackManifest,
  policy?: OperationPolicy | undefined
): string {
  const lines = [
    "Run TypeScript in Tack's sandboxed runtime. Scope persists across `execute` calls —",
    "fetch once, refine over cells; `{ fresh: true }` starts a clean scope.",
    "",
    "1. `tools.search({ query: \"\" })` lists namespaces; `({ query: \"\", namespace })` lists its",
    "   operations; `({ query })` keyword-searches. Items carry `params` (required input keys).",
    "2. `tools.describe.tool({ path })` for the full input schema when `params` isn't enough",
    "   (`{ types: true }` adds TypeScript defs).",
    "3. Call via `tools.call(path, args)` or `tools.<namespace>.<...>(args)`. Await calls. Don't",
    "   pass discriminator fields Tack already injects.",
    "4. `emit(value)` is user-visible output; `return value` is the model-readable final result.",
    "",
    "A large value comes back as `{ __tackRef: \"$1\", type, preview }` — use `$1` / `$_` in the",
    "next cell, or `deref({ session, ref })` (the `session` id is in each result).",
    "",
    'Call `guide({ name: "execute" })` for file outputs, limits, and more detail.'
  ];
  const inventory = renderNamespaceInventory(manifest, policy);
  if (inventory.length > 0) {
    lines.push("", inventory);
  }
  return lines.join("\n");
}

export function renderGuideIndex(): string {
  return [
    "Available guides:",
    "",
    `- \`${EXECUTE_GUIDE_NAME}\` - Write code for the execute tool.`
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
    description: "Write code for the execute tool.",
    body: renderExecuteGuide(manifest, policy)
  };
}

export function renderExecuteGuide(
  manifest: TackManifest,
  policy?: OperationPolicy | undefined
): string {
  return [
    "# execute",
    "",
    "## Workflow",
    "",
    "1. `tools.search({ query: \"\" })` lists namespaces; `tools.search({ query: \"\", namespace })` lists that namespace's operations; `tools.search({ query })` keyword-searches across all of them.",
    "2. Search results carry `params` (required input keys) — for a simple tool you can call it straight away; use `tools.describe.tool({ path })` when you need the full input schema (add `{ types: true }` for TypeScript defs).",
    "3. Call operations with `tools.call(path, args)` or inferred methods like `tools.grafana.datasources.list(args)`.",
    "4. Use `emit(value)` for user-visible intermediate output and `return value` for the final result.",
    "",
    "## Rules",
    "",
    "- Write JavaScript or TypeScript only.",
    "- Await tool calls.",
    "- Use operation paths from search results.",
    "- Do not pass discriminator fields that Tack already injects.",
    "- `emit(value)` appends user-visible MCP output. Plain values become text, MCP content blocks are forwarded, and ToolFile values are rendered by MIME.",
    '- ToolFile shape is `{ _tag: "ToolFile", name?, mimeType, encoding: "base64", data, byteLength }`.',
    "- ToolFile emits render `image/*` as MCP images, `audio/*` as MCP audio, text-like files as decoded text, and other files as embedded resources.",
    "- `return value` is for the model-readable final result in structuredContent. Return ordinary structured data, not files or bare base64.",
    "- MCP result/error previews are truncated at 30000 chars; emitted text files are truncated at 64000 chars.",
    "",
    "## Example",
    "",
    "```ts",
    "const matches = await tools.search({ query: \"list datasources\", limit: 1 });",
    "const details = await tools.describe.tool({ path: matches.items[0].path });",
    "const result = await tools.call(details.path, {});",
    "emit({ path: details.path });",
    "return result;",
    "```",
    "",
    "## Scope carries across cells",
    "",
    "Every `execute` call runs in this connection's persistent session — no setup.",
    "Top-level `const`/`let`/`function`/`class` (and reassignments like `count++`)",
    "from one cell are in scope in the next, so fetch once and refine over several",
    "cells instead of re-fetching. Pass `{ fresh: true }` to start a clean scope.",
    "The `session` id comes back with each result; sessions expire when idle.",
    "",
    "A large returned or emitted value is kept in the kernel instead of inlined: you",
    "get `{ __tackRef: \"$1\", type, preview }`. Use `$1` (or `$_` for the last) as a",
    "normal variable in the next cell, or `deref({ session, ref, offset?, limit? })`",
    "to page it out.",
    "",
    "```ts",
    "// cell 1",
    "const rules = await tools.grafana.alerting.rules.list();",
    "// cell 2 — same scope",
    "return rules.data.filter((r) => r.state === \"firing\").length;",
    "```",
    "",
    renderNamespaceInventory(manifest, policy)
  ].join("\n");
}

function availableNamespaces(
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
