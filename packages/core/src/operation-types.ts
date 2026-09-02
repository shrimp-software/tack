import { dedupeName, typeSegment } from "./ids.js";
import type { TackOperation } from "./types.js";

/**
 * The PascalCase base every generated type name for an operation is built from:
 * `<Namespace><PathSegments…>` (e.g. `grafana` + `["datasources", "list"]` →
 * `GrafanaDatasourcesList`). The `Input` / `Output` / `Result` suffixes are
 * appended by {@link assignOperationTypeNames}.
 */
export function operationTypeBase(operation: TackOperation): string {
  return [operation.namespaceName, ...operation.path].map(typeSegment).join("");
}

export interface OperationTypeNames {
  readonly inputType: string;
  readonly outputType: string;
  readonly resultType: string;
}

/**
 * Assign a stable, collision-free set of TypeScript type names to every
 * operation, keyed by `fullPathString`. Two distinct operations whose paths
 * PascalCase to the same base get `…`, `…2`, `…3` suffixes — the assignment is
 * deterministic and independent of input array order because it sorts by
 * `fullPathString` first.
 *
 * This is the single source of type-name truth: the static SDK
 * (`@cbxss/tack-generator`) and the code-mode surfaces (`@cbxss/tack-codemode` —
 * `describe.tool`, the ambient `tools` `.d.ts`) all resolve names through here
 * so they never drift.
 */
export function assignOperationTypeNames(
  operations: readonly TackOperation[]
): Map<string, OperationTypeNames> {
  const sorted = [...operations].sort((left, right) =>
    left.fullPathString.localeCompare(right.fullPathString)
  );

  const usedTypeBases = new Set<string>();
  const names = new Map<string, OperationTypeNames>();
  for (const operation of sorted) {
    const base = dedupeName(operationTypeBase(operation), usedTypeBases);
    names.set(operation.fullPathString, {
      inputType: `${base}Input`,
      outputType: `${base}Output`,
      resultType: `${base}Result`
    });
  }

  return names;
}
