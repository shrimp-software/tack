import {
  findOperation,
  listOperations,
  ownField,
  type JsonSchema,
  type TackManifest,
  type TackOperation
} from "@tack/core";

import { operationTypeScript } from "./operation-typescript.js";
import { filterAllowedOperations, type OperationPolicy } from "./policy.js";

export interface SearchInput {
  readonly query: string;
  readonly namespace?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  /** With a `namespace` set, attach `inputTypeScript`/`outputTypeScript` to each
   *  item — full types for one namespace without a `describe.tool` per tool.
   *  Ignored without a `namespace` (never compiles the whole catalog). */
  readonly types?: boolean | undefined;
}

export interface SearchItem {
  /** `namespace.path.to.op` — `namespace` and the leaf id are read off this. */
  readonly path: string;
  readonly description?: string | undefined;
  /** Required input keys. Absent means the operation takes no required args, so
   *  you can often call it directly without `describe.tool`. */
  readonly params?: readonly string[] | undefined;
  readonly example: string;
  /** Present only on a keyword search — why this operation matched. */
  readonly score?: number | undefined;
  readonly matchedTokens?: readonly string[] | undefined;
  /** Present only on `search({ namespace, types: true })`. */
  readonly inputTypeScript?: string | undefined;
  readonly outputTypeScript?: string | undefined;
}

export interface SearchResult {
  readonly items: readonly SearchItem[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
}

export interface NamespaceSummary {
  readonly namespace: string;
  readonly serverId: string;
  readonly operations: number;
}

export interface NamespaceIndex {
  readonly namespaces: readonly NamespaceSummary[];
  readonly total: number;
}

/**
 * The top-level catalog view: one entry per namespace with its operation count.
 * This is what `tools.search({ query: "" })` returns — pick a namespace, then
 * `tools.search({ query: "", namespace })` to list its operations.
 */
export function listNamespaces(manifest: TackManifest, policy?: OperationPolicy): NamespaceIndex {
  const operations = filterAllowedOperations(listOperations(manifest), policy);
  const byNamespace = new Map<string, { serverId: string; operations: number }>();
  for (const operation of operations) {
    const existing = byNamespace.get(operation.namespaceName);
    if (existing) {
      existing.operations += 1;
    } else {
      byNamespace.set(operation.namespaceName, { serverId: operation.serverId, operations: 1 });
    }
  }

  const namespaces = [...byNamespace.entries()]
    .map(([namespace, { serverId, operations: count }]) => ({
      namespace,
      serverId,
      operations: count
    }))
    .sort((left, right) => left.namespace.localeCompare(right.namespace));

  return { namespaces, total: operations.length };
}

export function searchOperations(
  manifest: TackManifest,
  input: SearchInput,
  policy?: OperationPolicy
): SearchResult {
  const query = normalizeSearchText(typeof input.query === "string" ? input.query : "");
  const namespace = typeof input.namespace === "string" ? normalizeSearchText(input.namespace) : undefined;
  const limit = clampInt(typeof input.limit === "number" ? input.limit : 12, 1, 50);
  const offset = Math.max(0, Math.floor(typeof input.offset === "number" ? input.offset : 0));
  const operations = filterAllowedOperations(listOperations(manifest), policy)
    .filter((operation) => !namespace || normalizeSearchText(operation.namespaceName) === namespace);

  // An empty query lists the whole (paginated) catalog — that's what an agent
  // calling `search({ query: "" })` to discover operations wants.
  const matches = query.length === 0
    ? operations
      .sort((left, right) => left.fullPathString.localeCompare(right.fullPathString))
      .map((operation) => ({ operation, score: 0, matchedTokens: [] }))
    : operations
      .map((operation) => ({ operation, ...scoreOperation(operation, query) }))
      .filter((match) => match.score > 0 && hasEnoughCoverage(query, {
        matchedTokens: match.matchedTokens,
        primaryMatchedTokens: match.primaryMatchedTokens
      }))
      .sort((left, right) =>
        right.score === left.score
          ? left.operation.fullPathString.localeCompare(right.operation.fullPathString)
          : right.score - left.score
      );

  const items = matches
    .slice(offset, offset + limit)
    .map(({ operation, score, matchedTokens }) => toSearchItem(operation, score, matchedTokens));
  const consumed = offset + items.length;
  return {
    items,
    total: matches.length,
    hasMore: consumed < matches.length,
    nextOffset: consumed < matches.length ? consumed : null
  };
}

export function normalizeSearchInput(input: unknown): SearchInput {
  if (typeof input === "string") {
    return { query: input };
  }

  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const query = ownField<unknown>(input, "query");
    const namespace = ownField<unknown>(input, "namespace");
    const limit = ownField<unknown>(input, "limit");
    const offset = ownField<unknown>(input, "offset");
    const types = ownField<unknown>(input, "types");
    return {
      query: typeof query === "string" ? query : "",
      ...(typeof namespace === "string" ? { namespace } : {}),
      ...(typeof limit === "number" ? { limit } : {}),
      ...(typeof offset === "number" ? { offset } : {}),
      ...(types === true ? { types: true } : {})
    };
  }

  return { query: "" };
}

/**
 * Attach `inputTypeScript`/`outputTypeScript` to each item of a search result.
 * Used for `search({ namespace, types: true })`. The caller is responsible for
 * only invoking this when a `namespace` narrowed the result — it compiles one
 * schema pair per item.
 */
export async function attachTypeScript(
  result: SearchResult,
  manifest: TackManifest
): Promise<SearchResult> {
  const items = await Promise.all(
    result.items.map(async (item) => {
      const operation = findOperation(manifest, item.path);
      if (!operation) {
        return item;
      }
      const { inputTypeScript, outputTypeScript } = await operationTypeScript(operation);
      return {
        ...item,
        inputTypeScript,
        ...(outputTypeScript ? { outputTypeScript } : {})
      };
    })
  );

  return { ...result, items };
}


function toSearchItem(
  operation: TackOperation,
  score: number,
  matchedTokens: readonly string[]
): SearchItem {
  const params = requiredParams(operation.inputSchema);
  return {
    path: operation.fullPathString,
    ...(operation.description ? { description: operation.description } : {}),
    ...(params.length > 0 ? { params } : {}),
    example: operation.examples[0] ?? "",
    ...(score > 0 ? { score, matchedTokens } : {})
  };
}

/** Top-level `required` property names of an operation's input schema. */
function requiredParams(schema: JsonSchema): readonly string[] {
  const required = (schema as { readonly required?: unknown }).required;
  return Array.isArray(required)
    ? required.filter((key): key is string => typeof key === "string")
    : [];
}

function scoreOperation(
  operation: TackOperation,
  query: string
): {
  readonly score: number;
  readonly matchedTokens: readonly string[];
  readonly primaryMatchedTokens: readonly string[];
} {
  const fields = weightedFields(operation)
    .map((field) => ({
      weight: field.weight,
      primary: field.primary,
      text: normalizeSearchText(field.text),
      tokens: searchTokens(field.text)
    }))
    .filter((field) => field.text.length > 0);
  const tokens = query.split(" ").filter(Boolean);
  const matchedTokens = new Set<string>();
  const primaryMatchedTokens = new Set<string>();

  let score = 0;
  for (const field of fields) {
    if (field.text === query) {
      score += field.weight * 8;
    } else if (field.text.includes(query)) {
      score += field.weight * 4;
    }

    for (const token of tokens) {
      const tokenScore = scoreToken(token, field.tokens);
      if (tokenScore > 0) {
        score += field.weight * tokenScore;
        matchedTokens.add(token);
        if (field.primary) {
          primaryMatchedTokens.add(token);
        }
      }
    }
  }

  const coverage = tokens.length === 0 ? 0 : matchedTokens.size / tokens.length;
  if (coverage === 1) {
    score += 25;
  } else {
    score += Math.round(coverage * 10);
  }

  return {
    score,
    matchedTokens: [...matchedTokens].sort(),
    primaryMatchedTokens: [...primaryMatchedTokens].sort()
  };
}

function hasEnoughCoverage(
  query: string,
  match: {
    readonly matchedTokens: readonly string[];
    readonly primaryMatchedTokens: readonly string[];
  }
): boolean {
  const tokens = query.split(" ").filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }

  const coverage = match.matchedTokens.length / tokens.length;
  if (coverage < (tokens.length <= 2 ? 1 : 0.6)) {
    return false;
  }

  const primaryCoverage = match.primaryMatchedTokens.length / tokens.length;
  if (match.primaryMatchedTokens.length === 0) {
    return coverage === 1;
  }

  return primaryCoverage >= (tokens.length <= 2 ? 1 : 0.6);
}

interface WeightedField {
  readonly text: string;
  readonly weight: number;
  readonly primary: boolean;
}

function weightedFields(operation: TackOperation): WeightedField[] {
  return [
    { text: operation.fullPathString, weight: 18, primary: true },
    { text: operation.pathString, weight: 15, primary: true },
    ...operation.path.map((segment) => ({ text: segment, weight: 12, primary: true })),
    { text: operation.toolId, weight: 8, primary: true },
    { text: operation.upstreamName, weight: 8, primary: true },
    { text: operation.namespaceName, weight: 6, primary: true },
    { text: operation.serverId, weight: 5, primary: true },
    ...(operation.description ? [{ text: operation.description, weight: 5, primary: true }] : []),
    ...operation.examples.map((example) => ({ text: example, weight: 4, primary: true })),
    ...schemaTerms(operation.inputSchema).map((term) => ({ text: term, weight: 4, primary: false })),
    ...schemaTerms(operation.outputSchema).map((term) => ({ text: term, weight: 3, primary: false }))
  ];
}

function scoreToken(token: string, fieldTokens: readonly string[]): number {
  if (fieldTokens.includes(token)) {
    return 3;
  }

  if (fieldTokens.some((fieldToken) => fieldToken.includes(token) || token.includes(fieldToken))) {
    return 2;
  }

  if (fieldTokens.some((fieldToken) => isFuzzyTokenMatch(token, fieldToken))) {
    return 1;
  }

  return 0;
}

function schemaTerms(schema: unknown): string[] {
  if (!schema) {
    return [];
  }

  const terms = new Set<string>();
  collectSchemaTerms(schema, terms, 0, new WeakSet<object>());
  return [...terms];
}

function collectSchemaTerms(
  value: unknown,
  terms: Set<string>,
  depth: number,
  seen: WeakSet<object>
): void {
  if (depth > 6 || typeof value !== "object" || value === null) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        terms.add(String(item));
      } else {
        collectSchemaTerms(item, terms, depth + 1, seen);
      }
    }
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (key === "$schema") {
      continue;
    }

    terms.add(key);
    if (
      key === "title" ||
      key === "description" ||
      key === "const" ||
      key === "default"
    ) {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        terms.add(String(item));
      }
      continue;
    }

    collectSchemaTerms(item, terms, depth + 1, seen);
  }
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function searchTokens(value: string): string[] {
  const normalized = normalizeSearchText(value);
  const base = normalized.split(" ").filter(Boolean);
  const variants = new Set<string>(base);

  if (base.length > 1) {
    variants.add(base.join(""));
    variants.add(base.map((token) => token[0]).join(""));
  }

  for (const token of base) {
    variants.add(singularize(token));
    variants.add(pluralize(token));
  }

  return [...variants].filter((token) => token.length > 0);
}

function singularize(token: string): string {
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("ses") && token.length > 4) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

function pluralize(token: string): string {
  if (token.endsWith("y") && token.length > 2) {
    return `${token.slice(0, -1)}ies`;
  }
  if (token.endsWith("s")) {
    return token;
  }
  return `${token}s`;
}

function isFuzzyTokenMatch(left: string, right: string): boolean {
  if (left.length < 4 || right.length < 4) {
    return false;
  }

  const distance = levenshtein(left, right);
  return distance <= (Math.max(left.length, right.length) <= 6 ? 1 : 2);
}

function levenshtein(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + cost
      );
    }

    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index] ?? 0;
    }
  }

  return previous[right.length] ?? Number.POSITIVE_INFINITY;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.floor(value)));
}
