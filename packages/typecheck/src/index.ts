// @cbxss/tack-typecheck — a persistent in-process TypeScript language service that
// checks a code-mode cell against a synthesized ambient `tools` surface before
// it runs. Implements the `TypeChecker` seam from `@cbxss/tack-codemode`; injected
// into `createExecutionEngine` by the CLI.

export { buildAmbientDts } from "./ambient.js";
export { createTypeChecker, type CreateTypeCheckerOptions } from "./checker.js";
