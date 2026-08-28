import type { ToolTraceEvent } from "./types.js";

/**
 * A one-line, human-readable rendering of a live trace event — for MCP progress
 * messages and CLI stderr. Operation identity, status and timing only; never
 * arguments or results.
 */
export function formatTraceLine(event: ToolTraceEvent): string {
  if (event.type === "tool_call_start") {
    return `→ ${event.path}`;
  }

  if (event.type === "builtin_call") {
    const status = event.ok ? "ok" : `error${event.error ? `: ${event.error}` : ""}`;
    return `← ${event.path} ${status} (${event.durationMs}ms)`;
  }

  if (event.allowed === false) {
    return `✗ ${event.path} denied${event.error ? `: ${event.error}` : ""}`;
  }

  const status = event.ok === false ? `error${event.error ? `: ${event.error}` : ""}` : "ok";
  const timing = event.durationMs === undefined ? "" : ` (${event.durationMs}ms)`;
  return `← ${event.path} ${status}${timing}`;
}
