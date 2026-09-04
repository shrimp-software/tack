// Authoring API — write these in a module source file.
export { defineTool, isTackTool } from "./define.js";
export type {
  PlainToolSpec,
  TackToolDefinition,
  ToolExecutionContext,
  ToolSchema,
  ZodToolSpec
} from "./define.js";

// Integration API — discover every configured source and run its tools.
export { createRuntime, discoverManifest, SOURCE_KINDS } from "./dispatch.js";
export type { CreateRuntimeOptions, WorkspaceOptions } from "./dispatch.js";

// Extension point — implement `Source` (discover + run) and pair it with a
// `SourceKind` from `@cbxss/tack-core` (config shape + manifest projection).
export { sourceTransports } from "./source.js";
export type { Source, SourceRuntimeInput, SourceServerEntry } from "./source.js";
export type { SourceKind } from "@cbxss/tack-core";
