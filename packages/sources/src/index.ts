// Authoring API — write these in a module source file.
export { defineTool, isTackTool } from "./define.js";
export type {
  PlainToolSpec,
  TackToolDefinition,
  ToolSchema,
  ZodToolSpec
} from "./define.js";

// Integration API — discover every configured source and run its tools.
export { createRuntime, discoverManifest } from "./dispatch.js";
export type { CreateRuntimeOptions } from "./dispatch.js";

// Extension point — implement this to add a source kind.
export type { Source, SourceRuntimeInput, SourceServerEntry } from "./source.js";
