/**
 * The result type every code-mode tool call resolves to. `await tools.x()`
 * inside `execute` returns this shape; it is the discriminated-union narrowing
 * of `@tack/codemode`'s runtime `ToolCallOutput`
 * (`{ ok; data?; text; raw?; error? }`).
 *
 * Single-sourced here as BOTH a string (emitted verbatim into generated `.ts` /
 * ambient `.d.ts` by `@tack/sdk-types`) and a real type (for internal
 * assertions), so the two can never disagree.
 *
 * Distinct from `TackResult<T>` in `./types.ts`, which is the method-bearing
 * result the static SDK client returns — do not conflate.
 */
export const CODE_MODE_RESULT_TS =
  "type CodeModeResult<T> =\n" +
  "  | { ok: true; data: T; text: string; raw?: unknown }\n" +
  "  | { ok: false; error: { message: string }; text: string; raw?: unknown };\n";

export type CodeModeResult<T> =
  | { ok: true; data: T; text: string; raw?: unknown }
  | { ok: false; error: { message: string }; text: string; raw?: unknown };
