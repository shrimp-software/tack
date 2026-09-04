import { ownField } from "@cbxss/tack-core";

export interface QuickJSRuntimeOptions {
  readonly timeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly memoryMb?: number;
  readonly maxStackBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxToolCalls?: number;
  readonly maxToolRequestBytes?: number;
  readonly maxToolResponseBytes?: number;
  readonly maxInlineResultBytes?: number;
}

export interface QuickJSLimits {
  readonly timeoutMs: number;
  readonly toolTimeoutMs: number;
  readonly memoryMb: number;
  readonly maxStackBytes: number;
  readonly maxOutputBytes: number;
  readonly maxToolCalls: number;
  readonly maxToolRequestBytes: number;
  readonly maxToolResponseBytes: number;
  readonly maxInlineResultBytes: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_MB = 128;
const DEFAULT_MAX_STACK_BYTES = 1_000_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_MAX_TOOL_CALLS = 100;
const DEFAULT_MAX_TOOL_REQUEST_BYTES = 1_000_000;
const DEFAULT_MAX_TOOL_RESPONSE_BYTES = 1_000_000;
const DEFAULT_MAX_INLINE_RESULT_BYTES = 4_096;

export function normalizeRuntimeOptions(options: QuickJSRuntimeOptions): QuickJSLimits {
  const timeoutMs = readOwnNumber(options, "timeoutMs") ?? DEFAULT_TIMEOUT_MS;
  return {
    timeoutMs,
    toolTimeoutMs: readOwnNumber(options, "toolTimeoutMs") ?? timeoutMs,
    memoryMb: readOwnNumber(options, "memoryMb") ?? DEFAULT_MEMORY_MB,
    maxStackBytes: readOwnNumber(options, "maxStackBytes") ?? DEFAULT_MAX_STACK_BYTES,
    maxOutputBytes: readOwnNumber(options, "maxOutputBytes") ?? DEFAULT_MAX_OUTPUT_BYTES,
    maxToolCalls: readOwnNumber(options, "maxToolCalls") ?? DEFAULT_MAX_TOOL_CALLS,
    maxToolRequestBytes: readOwnNumber(options, "maxToolRequestBytes") ?? DEFAULT_MAX_TOOL_REQUEST_BYTES,
    maxToolResponseBytes: readOwnNumber(options, "maxToolResponseBytes") ?? DEFAULT_MAX_TOOL_RESPONSE_BYTES,
    maxInlineResultBytes: readOwnNumber(options, "maxInlineResultBytes") ?? DEFAULT_MAX_INLINE_RESULT_BYTES
  };
}

function readOwnNumber(options: QuickJSRuntimeOptions, key: keyof QuickJSRuntimeOptions): number | undefined {
  const value = ownField(options, key);
  return typeof value === "number" ? value : undefined;
}
