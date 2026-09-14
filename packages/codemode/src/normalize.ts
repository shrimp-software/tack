/**
 * Optional clean-up pass for downstream tool responses. Real MCP servers
 * often return strings padded with incidental whitespace — trailing spaces,
 * runs of blank lines, tab/space litter from a templated report — none of
 * which carries meaning. Enabled per-config (`runtime.normalizeWhitespace`),
 * this walks `.data` and tidies every string leaf before it reaches the
 * sandbox; it never touches keys, non-string values, or numeric content.
 *
 * `value` is always JSON-derived (parsed response text or MCP
 * `structuredContent`), so it's finite and acyclic — no depth cap needed.
 */
export function cleanWhitespace(value: unknown): unknown {
  if (typeof value === "string") return cleanWhitespaceString(value);
  if (Array.isArray(value)) return value.map(cleanWhitespace);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [key, cleanWhitespace(val)])
    );
  }
  return value;
}

function cleanWhitespaceString(input: string): string {
  return input
    .replace(/[ \t]+/g, " ") // collapse runs of spaces/tabs to one
    .replace(/[ \t]*\r?\n[ \t]*/g, "\n") // drop padding hugging line breaks
    .replace(/\n{3,}/g, "\n\n") // collapse 3+ blank lines to a single paragraph break
    .trim();
}
