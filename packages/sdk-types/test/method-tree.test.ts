import { describe, expect, it } from "vitest";

import { buildMethodTree, renderInterfaceTree, type MethodLike } from "../src/index.js";

function method(overrides: Partial<MethodLike> & Pick<MethodLike, "path">): MethodLike {
  return {
    namespaceName: "grafana",
    inputType: "FooInput",
    outputType: "FooOutput",
    resultType: "FooResult",
    inputSchema: { type: "object" },
    examples: [],
    ...overrides
  };
}

describe("buildMethodTree", () => {
  it("nests by path segment", () => {
    const tree = buildMethodTree([
      method({ path: ["datasources", "list"] }),
      method({ path: ["datasources", "get"] })
    ]);
    expect([...tree.children.keys()]).toEqual(["datasources"]);
    expect([...tree.children.get("datasources")!.children.keys()]).toEqual(["list", "get"]);
  });

  it("throws when one path is a prefix of another", () => {
    expect(() =>
      buildMethodTree([method({ path: ["a"] }), method({ path: ["a", "b"] })])
    ).toThrow(/must not overlap/);
  });
});

describe("renderInterfaceTree", () => {
  it("applies the result callback to leaf return types", () => {
    const tree = buildMethodTree([
      method({ path: ["list"], inputType: "ListInput", outputType: "ListOutput" })
    ]);
    const lines = renderInterfaceTree(tree, "  ", {
      result: (m) => `CodeModeResult<${m.outputType}>`
    });
    expect(lines.join("\n")).toContain('"list"(args?: ListInput): Promise<CodeModeResult<ListOutput>>;');
  });

  it("allows the live SDK to add call options without changing the default signature", () => {
    const tree = buildMethodTree([method({ path: ["list"], inputType: "ListInput" })]);
    const lines = renderInterfaceTree(tree, "  ", {
      result: () => "TackResponse<unknown>",
      parameters: () => "args?: ListInput, options?: TackCallOptions"
    });
    expect(lines.join("\n")).toContain('"list"(args?: ListInput, options?: TackCallOptions): Promise<TackResponse<unknown>>;');
  });

  it("applies an optional namespace base recursively without changing legacy trees", () => {
    const tree = buildMethodTree([method({ path: ["server", "group", "read"] })]);
    const options = { result: (m: MethodLike) => m.resultType };
    const live = renderInterfaceTree(tree, "  ", { ...options, namespaceType: "TackToolNamespace" }).join("\n");
    expect(live).toContain('readonly "server": TackToolNamespace & {');
    expect(live).toContain('readonly "group": TackToolNamespace & {');
    expect(renderInterfaceTree(tree, "  ", options).join("\n")).not.toContain("TackToolNamespace");
  });

  it("wraps live callable leaves without changing legacy method rendering", () => {
    const tree = buildMethodTree([method({ path: ["group", "read"], description: "Read a value." })]);
    const options = { result: (m: MethodLike) => m.resultType };
    const live = renderInterfaceTree(tree, "  ", { ...options, callableType: "TackTool" }).join("\n");
    expect(live).toContain("* Read a value.");
    expect(live).toContain('readonly "read": TackTool<(args?: FooInput) => Promise<FooResult>>;');
    const legacy = renderInterfaceTree(tree, "  ", options).join("\n");
    expect(legacy).toContain('"read"(args?: FooInput): Promise<FooResult>;');
    expect(legacy).not.toContain("TackTool");
  });

  it("marks a required-input method's args as non-optional", () => {
    const tree = buildMethodTree([
      method({
        path: ["get"],
        inputType: "GetInput",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
      })
    ]);
    const lines = renderInterfaceTree(tree, "  ", { result: (m) => m.resultType });
    expect(lines.join("\n")).toContain('"get"(args: GetInput): Promise<FooResult>;');
  });
});
