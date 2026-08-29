import { ownField } from "@tack/core";

export interface WorkerdRuntimeOptions {
  readonly timeoutMs?: number;
  readonly memoryMb?: number;
  readonly maxOutputBytes?: number;
  readonly maxToolCalls?: number;
  readonly maxToolRequestBytes?: number;
  readonly maxToolResponseBytes?: number;
  readonly startupTimeoutMs?: number;
  readonly hostTimeoutGraceMs?: number;
  readonly workerdBin?: string;
}

export interface WorkerdRuntimeSettings {
  readonly timeoutMs: number;
  readonly memoryMb?: number | undefined;
  readonly maxOutputBytes: number;
  readonly maxToolCalls: number;
  readonly maxToolRequestBytes: number;
  readonly maxToolResponseBytes: number;
  readonly startupTimeoutMs: number;
  readonly hostTimeoutGraceMs: number;
  readonly workerdBin?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_MAX_TOOL_CALLS = 100;
const DEFAULT_MAX_TOOL_REQUEST_BYTES = 1_000_000;
const DEFAULT_MAX_TOOL_RESPONSE_BYTES = 1_000_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_HOST_TIMEOUT_GRACE_MS = 2_000;

export function normalizeRuntimeOptions(options: WorkerdRuntimeOptions): WorkerdRuntimeSettings {
  return {
    timeoutMs: readOwnNumber(options, "timeoutMs") ?? DEFAULT_TIMEOUT_MS,
    ...optionalNumber(options, "memoryMb"),
    maxOutputBytes: readOwnNumber(options, "maxOutputBytes") ?? DEFAULT_MAX_OUTPUT_BYTES,
    maxToolCalls: readOwnNumber(options, "maxToolCalls") ?? DEFAULT_MAX_TOOL_CALLS,
    maxToolRequestBytes: readOwnNumber(options, "maxToolRequestBytes") ?? DEFAULT_MAX_TOOL_REQUEST_BYTES,
    maxToolResponseBytes: readOwnNumber(options, "maxToolResponseBytes") ?? DEFAULT_MAX_TOOL_RESPONSE_BYTES,
    startupTimeoutMs: readOwnNumber(options, "startupTimeoutMs") ?? DEFAULT_STARTUP_TIMEOUT_MS,
    hostTimeoutGraceMs: readOwnNumber(options, "hostTimeoutGraceMs") ?? DEFAULT_HOST_TIMEOUT_GRACE_MS,
    ...optionalString(options, "workerdBin")
  };
}

function readOwnNumber(
  options: WorkerdRuntimeOptions,
  key: keyof WorkerdRuntimeOptions
): number | undefined {
  const value = ownField(options, key);
  return typeof value === "number" ? value : undefined;
}

function optionalNumber<K extends keyof WorkerdRuntimeSettings>(
  options: WorkerdRuntimeOptions,
  key: K
): Pick<WorkerdRuntimeSettings, K> | Record<string, never> {
  const value = readOwnNumber(options, key);
  return typeof value === "number" ? { [key]: value } as Pick<WorkerdRuntimeSettings, K> : {};
}

function optionalString<K extends keyof WorkerdRuntimeSettings>(
  options: WorkerdRuntimeOptions,
  key: K
): Pick<WorkerdRuntimeSettings, K> | Record<string, never> {
  const value = ownField(options, key);
  return typeof value === "string" ? { [key]: value } as Pick<WorkerdRuntimeSettings, K> : {};
}
