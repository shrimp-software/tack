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
