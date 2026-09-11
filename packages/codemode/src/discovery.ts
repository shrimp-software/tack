import {
  BUILTIN_CONTRACTS,
  findOperation,
  listOperations,
  RESERVED_TOOL_KEYS,
  type BuiltinName,
  type TackManifest,
} from "@cbxss/tack-core";
import { describeTool } from "./describe.js";
import {
  catalogRevision,
  ExecutionHost,
  jsonBytes,
} from "./host.js";
import { findGuide } from "./guide.js";
import { operationTypeScript } from "./operation-typescript.js";
import { listNamespaces, searchOperations } from "./search.js";
import type { OperationPolicy } from "./policy.js";

export function assertToolNamespaces(manifest: TackManifest): void {
  for (const op of listOperations(manifest)) {
    if (RESERVED_TOOL_KEYS.has(op.namespaceName))
      throw new Error(`Reserved tool namespace: ${op.namespaceName}`);
  }
}

export async function invokeBuiltin(
  path: BuiltinName,
  args: unknown,
  context: {
    manifest: TackManifest;
    policy?: OperationPolicy | undefined;
    host?: ExecutionHost | undefined;
    responseOwner: string;
    executionId?: string | undefined;
  },
  _signal?: AbortSignal,
): Promise<unknown> {
  const input = BUILTIN_CONTRACTS[path].input.parse(args) as Record<
    string,
    unknown
  >;
  const { manifest, policy } = context;
  if (path === "guidance.read")
    return findGuide("execute", manifest, policy)!.body;
  // When a schema/signature blob is too large for the inline discovery budget,
  // drop the heavy fields and keep the actionable ones (path, name, description,
  // params, example) with a `schemaTruncated` marker. No retrieval handle.
  const HEAVY_FIELDS = [
    "inputTypeScript",
    "outputTypeScript",
    "typeScriptDefinitions",
    "inputSchema",
    "outputSchema",
  ] as const;
  function bounded<T extends { path: string }>(
    item: T,
  ): T | { path: string; schemaTruncated: true } {
    if (jsonBytes(item) <= 6000) return item;
    const trimmed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (!(HEAVY_FIELDS as readonly string[]).includes(key)) trimmed[key] = value;
    }
    return { ...trimmed, path: item.path, schemaTruncated: true };
  }
  if (path === "describe.tool")
    return bounded(
      await describeTool(
        manifest,
        input as { path: string; types?: boolean },
        policy,
      ),
    );
  const revision = catalogRevision(manifest);
  if (input.revision !== undefined && input.revision !== revision)
    throw new Error("catalog_revision_changed: restart discovery at offset 0");
  const offset = (input.offset as number | undefined) ?? 0;
  const limit = (input.limit as number | undefined) ?? 8;
  let candidates: Array<Record<string, unknown>>;
  let total: number;
  if (!input.query && !input.namespace) {
    const namespaces = listNamespaces(manifest, policy).namespaces;
    total = namespaces.length;
    candidates = namespaces
      .slice(offset, offset + limit)
      .map((row) => ({
        kind: "namespace",
        path: row.namespace,
        operations: row.operations,
      }));
  } else {
    const result = searchOperations(
      manifest,
      {
        query: (input.query as string | undefined) ?? "",
        namespace: input.namespace as string | undefined,
        limit,
        offset,
      },
      policy,
    );
    total = result.total;
    candidates = [];
    // Default results carry `inputSchema` + `example` — enough to call directly.
    // TypeScript signatures are opt-in (`types: true` / `detail: "full"`);
    // `detail: "summary"` drops the schema for a compact listing.
    const withTypes = input.types === true || input.detail === "full";
    for (const item of result.items) {
      const operation = findOperation(manifest, item.path)!;
      const types = withTypes ? await operationTypeScript(operation) : undefined;
      const { inputSchema: _schema, ...summaryItem } = item;
      void _schema;
      candidates.push({
        kind: "tool",
        ...bounded({
          ...(input.detail === "summary" ? summaryItem : item),
          ...(types ? { inputTypeScript: types.inputTypeScript, outputTypeScript: types.outputTypeScript ?? "unknown" } : {}),
        }),
      });
    }
  }
  const items: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    if (jsonBytes([...items, candidate]) > 12000) break;
    items.push(candidate);
  }
  const consumed = offset + items.length;
  return {
    ok: true,
    revision,
    items,
    total,
    hasMore: consumed < total,
    nextOffset: consumed < total ? consumed : null,
  };
}
