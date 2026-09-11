import { listOperations, type TackManifest } from "@cbxss/tack-core";

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
    "Execute TypeScript against connected tools. Every call runs fresh — no variables or state carry across calls.",
    "Runtime arguments are always validated. Semantic checking is off by default; omit typecheck for routine investigations.",
    "Discover: const {items} = await tools.search({query:'your task'}). Each item has `inputSchema` and a ready `example`; call directly — tools.<namespace>.<op>({...}) or tools.call(items[0].path,{...}). tools.describe.tool is only for the output schema or an ambiguous match. List identifiers (datasource/dashboard UIDs) before using them; a thin search result is not proof an operation is missing.",
    "A successful call returns {ok:true, data, responseId, dataShape}; a failed one {ok:false, error:{code,message}}. `data` is the full value in the sandbox — process it here and return a small summary. You cannot see `data` until a cell returns it: read `dataShape` (a compact type skeleton, always present) before writing `data.x.y` paths; shape(value,depth?) is a deeper view.",
    "Oversized downstream response: the call throws error.code 'response_too_large' — narrow the upstream query and retry. Oversized return value: comes back with resultTruncated:true, structure kept (array → leading items + {shown,total}; object → leading keys + {shownKeys,totalKeys,omitted}). Return aggregates, not raw payloads.",
    "More help: tools.guidance.read({name:'execute'})."
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
    summary: "Discover tools, call them, and summarize results in the execute sandbox.",
    body: renderExecuteGuide(manifest, policy)
  };
}

/** The full `execute` how-to, served on demand by the `guide` tool. */
export function renderExecuteGuide(
  manifest: TackManifest,
  policy?: OperationPolicy | undefined
): string {
  return [
    "# Execute",
    "Discover with tools.search({query?,namespace?,limit?,offset?,types?}). Every result item carries `path`, `description`, `params` (required keys), the full `inputSchema`, and a copy-paste `example` — enough to call the operation directly. An empty query lists namespaces; add `namespace` to list one namespace's operations. `types:true` adds TypeScript signatures.",
    "Call tools.call(path,{...}) or tools.<namespace>.<operation>({...}) straight from the item's inputSchema/example. tools.describe.tool({path}) is only for the output schema or an ambiguous match — not a required step before a call. List identifiers (datasource/dashboard UIDs) before using them, never guess; a thin or empty search result is not evidence an operation is missing — broaden the query or list the namespace before concluding a capability is unavailable.",
    "A successful call returns {ok:true, data, responseId, dataShape}; a failed one {ok:false, error:{code,message}}. `data` is the whole value in the sandbox — filter and aggregate it in code. You cannot see `data` until a cell returns it: `dataShape` (a compact type skeleton, always present on success) is your first look at the layout — read it before writing property paths, and check it per result in a Promise.all batch rather than assuming a shared shape. shape(value,depth?) is a deeper on-demand view.",
    "Every call runs fresh — no variables, refs or saved-response reads persist; if a later step needs earlier data, call the tool again. No fetch or shell access.",
    "A downstream response too large to deliver into the sandbox rejects with error.code 'response_too_large' — narrow the upstream query and retry. A return value over the model budget comes back with resultTruncated:true keeping structure: an array's leading items plus {shown,total}, or an object's leading keys plus {shownKeys,totalKeys,omitted}. Return compact statistics and selected evidence, not entire log or time-series payloads.",
    "For time-relative reasoning read the current time from an environment/status/health operation, not from the newest timestamp in a result.",
    "Runtime argument validation is mandatory. Semantic TypeScript checking is opt-in with execute({code,typecheck:'strict'}). An error does not mean earlier calls were rolled back; never replay a write automatically.",
    renderNamespaceInventory(manifest, policy)
  ].join("\n\n");
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
    ...namespaces.slice(0, 24).map((namespace) => `- \`${namespace}\``),
    ...(namespaces.length > 24 ? ["More namespaces: tools.search({query:''})"] : [])
  ].join("\n");
}
