import { listOperations, type TackManifest } from "@tack/core";

import { filterAllowedOperations, type OperationPolicy } from "./policy.js";

export const TOOL_INVENTORY_HEADER = "## Available namespaces";

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
    "`emit` forwards MCP content blocks as-is; a `{ _tag: \"ToolFile\", mimeType, encoding: \"base64\",",
    "data, byteLength, name? }` renders by MIME (image/audio/text/resource). Return ordinary",
    "structured data as the final result, not files or base64. Previews truncate at 30000 chars;",
    "emitted text files at 64000."
  ];
  const inventory = renderNamespaceInventory(manifest, policy);
  if (inventory.length > 0) {
    lines.push("", inventory);
  }
  return lines.join("\n");
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
