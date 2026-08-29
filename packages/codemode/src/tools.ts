/**
 * The `tools` proxy prelude injected into every code-mode cell. `operationPaths`
 * (already policy-filtered) makes the proxy *navigable*: `Object.keys(tools)`
 * lists namespaces and `Object.keys(tools.gh)` lists that namespace's paths, so
 * an agent can walk `tools` structurally instead of only via `tools.search`.
 */
export function renderToolsPrelude(operationPaths: readonly string[] = []): string {
  return `
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
    return __tackInvoke(path.join("."), args[0] ?? {});
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
