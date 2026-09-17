import type { UpstreamOutcome } from "@cbxss/tack-core";
import { ToolDispatchError, type ToolCallOutput, type ToolErrorCode } from "@cbxss/tack-codemode";
import type { TackResponse } from "./types.js";

export type TackErrorCode = ToolErrorCode | "invalid_options" | "initialization_failed" | "client_closed";

export class TackError extends Error {
  readonly code: TackErrorCode;
  readonly path: string | undefined;
  readonly upstreamOutcome: UpstreamOutcome;

  constructor(message: string, options: {
    readonly code: TackErrorCode;
    readonly path?: string | undefined;
    readonly upstreamOutcome?: UpstreamOutcome;
    readonly cause?: unknown;
  }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TackError";
    this.code = options.code;
    this.path = options.path;
    this.upstreamOutcome = options.upstreamOutcome ?? "not_started";
  }
}

export function invocationError(cause: unknown, path: string): TackError {
  if (cause instanceof TackError) return cause;
  return new TackError(cause instanceof Error ? cause.message : "Tool invocation failed", {
    code: cause instanceof ToolDispatchError ? cause.code : "downstream_error",
    path,
    upstreamOutcome: cause instanceof ToolDispatchError ? cause.upstreamOutcome : "unknown",
    cause
  });
}

export function responseOrThrow(output: ToolCallOutput, path: string): TackResponse {
  if (!output.ok) {
    throw new TackError(output.error?.message ?? "Tool invocation failed", {
      code: output.error?.code ?? "internal_error",
      path,
      upstreamOutcome: output.upstreamOutcome ?? "unknown"
    });
  }
  return {
    ok: true,
    data: output.data,
    dataShape: output.dataShape,
    upstreamOutcome: "succeeded",
    responseId: output.responseId ?? null
  };
}
