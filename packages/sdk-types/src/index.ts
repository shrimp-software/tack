// @tack/sdk-types — the single schema→TypeScript compiler and type renderers.
// `@tack/generator` uses `compileSchema` + the method-tree renderers for the
// static SDK and `renderToolsAmbientDts` for `.tack/generated/tools.d.ts`;
// `@tack/codemode` uses `compileSchema` for `describe.tool` and
// `search({ namespace, types: true })`.
//
// This package owns everything that needs `json-schema-to-typescript`; the
// dependency is pinned here and nowhere else. Dep-free naming primitives
// (`typeSegment`, operation type-name assignment) live in `@tack/core`.

export { compileSchema, type CompileSchemaOptions } from "./compile-schema.js";
export {
  argSignature,
  buildMethodTree,
  jsDocTextLines,
  renderInterfaceTree,
  renderJsDoc,
  type MethodLike,
  type MethodTree,
  type RenderInterfaceTreeOptions
} from "./method-tree.js";
export {
  renderAmbientToolsBlock,
  renderToolsAmbientDts,
  DESCRIBED_TOOL_TS,
  SEARCH_RESULT_TS,
  type RenderToolsAmbientDtsOptions
} from "./tools-ambient.js";
