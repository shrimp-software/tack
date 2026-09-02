import type { TypeDiagnostic } from "./types.js";

/**
 * Render typecheck diagnostics as a compact list — one line each, positioned in
 * the model's original cell source. Used for the blocked `execute` result's
 * message and for CLI output.
 */
export function formatTypeDiagnostics(diagnostics: readonly TypeDiagnostic[]): string {
  return diagnostics
    .map((d) => `  ${d.line}:${d.column}  ${d.code}  ${d.message.replace(/\n/g, " ")}`)
    .join("\n");
}
