export function renderToolsPrelude(): string {
  return `
const __tackToolPathError = (path) =>
  new Error((path.length === 0 ? "tools" : "tools." + path.join(".")) + " is a lazy proxy and cannot be enumerated. Use tools.search({ query: \\"\\" }) to discover operations.");

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
  ownKeys() {
    throw __tackToolPathError(path);
  },
  getOwnPropertyDescriptor() {
    throw __tackToolPathError(path);
  }
});

const tools = __tackCreateTools();
`;
}
