/** Stable failure kinds for a rejected downstream tool dispatch. */
export const TOOL_DISPATCH_CODES = [
  "downstream_error",
  "tool_timeout",
  "cancelled"
] as const;

export type ToolDispatchCode = typeof TOOL_DISPATCH_CODES[number];

export class ToolDispatchError extends Error {
  constructor(
    readonly code: ToolDispatchCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ToolDispatchError";
  }
}

export function isToolDispatchCode(value: unknown): value is ToolDispatchCode {
  return typeof value === "string" && (TOOL_DISPATCH_CODES as readonly string[]).includes(value);
}

export function isToolDispatchError(error: unknown): error is ToolDispatchError {
  return error instanceof ToolDispatchError;
}
