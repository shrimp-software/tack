/**
 * The `tools` proxy prelude injected into every code-mode cell. `operationPaths`
 * (already policy-filtered) makes the proxy *navigable*: `Object.keys(tools)`
 * lists namespaces and `Object.keys(tools.gh)` lists that namespace's paths, so
 * an agent can walk `tools` structurally instead of only via `tools.search`.
 *
 * Also injects `shape(value, maxDepth?)` — a synchronous, no-round-trip
 * type-only structural skeleton, the same view every successful result already
 * carries as `dataShape`, just deeper by default. Kept in sync with
 * `describeShape` in `data-shape.ts`.
 */
export function renderToolsPrelude(operationPaths: readonly string[] = []): string {
  return `
const shape = (value, maxDepth = 5) => {
  let budget = 4000;
  const walk = (v, depth) => {
    if (budget <= 0) return "…";
    if (v === null) return "null";
    const t = typeof v;
    if (t !== "object") { budget -= 6; return t; }
    if (Array.isArray(v)) {
      budget -= 8;
      if (v.length === 0) return "array(0)";
      if (depth <= 0) return "array(" + v.length + ")";
      return { array: v.length, of: walk(v[0], depth - 1) };
    }
    const keys = Object.keys(v);
    budget -= 4 + keys.length * 3;
    if (depth <= 0) return "object{" + keys.slice(0, 12).join(",") + (keys.length > 12 ? ",…" : "") + "}";
    const out = {};
    for (const k of keys.slice(0, 24)) out[k] = walk(v[k], depth - 1);
    if (keys.length > 24) out["…"] = (keys.length - 24) + " more";
    return out;
  };
  try { return walk(value, maxDepth); } catch (e) { return "unknown"; }
};

const __tackOpTree = ${JSON.stringify(buildOperationTree(operationPaths))};
const __tackNodeAt = (path) =>
  path.reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), __tackOpTree);

const __tackCreateTools = (path = []) => new Proxy(() => undefined, {
  get(_target, prop) {
    if (prop === "then" || typeof prop === "symbol") return undefined;
    if (path.length === 0 && prop === "call") {
      return (toolPath, args = {}) => __tackInvoke(String(toolPath), args);
    }
    return __tackCreateTools([...path, String(prop)]);
  },
  apply(_target, _thisArg, args) {
    if (path.length === 0) throw new Error("Tool path missing in invocation");
    return __tackInvoke(path.join("."), args[0] === undefined ? {} : args[0]);
  },
  has(_target, prop) {
    const node = __tackNodeAt(path);
    return typeof prop === "string" && node !== null && typeof node === "object" && prop in node;
  },
  ownKeys() {
    const node = __tackNodeAt(path);
    return node !== null && typeof node === "object" ? Reflect.ownKeys(node) : [];
  },
  getOwnPropertyDescriptor(_target, prop) {
    const node = __tackNodeAt(path);
    if (typeof prop === "string" && node !== null && typeof node === "object" && prop in node) {
      return { enumerable: true, configurable: true, value: undefined };
    }
    return undefined;
  }
});

const tools = __tackCreateTools();
`;
}

/** `["gh.list", "gh.label.add"]` -> `{ gh: { list: 1, label: { add: 1 } } }`. */
function buildOperationTree(paths: readonly string[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const path of paths) {
    const segments = path.split(".").filter(Boolean);
    let node = root;
    segments.forEach((segment, index) => {
      if (index === segments.length - 1) {
        if (typeof node[segment] !== "object") {
          node[segment] = 1;
        }
        return;
      }
      if (typeof node[segment] !== "object" || node[segment] === null) {
        node[segment] = {};
      }
      node = node[segment] as Record<string, unknown>;
    });
  }
  return root;
}
