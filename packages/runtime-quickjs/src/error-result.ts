import {
  CodeModeParseError,
  CodeRuntimeTimeoutError,
  errorMessage,
  isToolDispatchError,
  isToolDispatchCode,
  type ExecuteErrorCode,
  type ExecuteErrorPhase
} from "@cbxss/tack-codemode";

export function executionErrorPhase(error: unknown, deadlineExceeded: boolean): ExecuteErrorPhase {
  if (error instanceof CodeRuntimeTimeoutError || deadlineExceeded) {
    return "timeout";
  }
  return error instanceof CodeModeParseError ? "parse" : "runtime";
}

export function executionErrorCode(
  error: unknown,
  deadlineExceeded: boolean,
  dispatchToken?: string
): ExecuteErrorCode {
  if (error instanceof CodeRuntimeTimeoutError || deadlineExceeded) return "execution_timeout";
  if (error instanceof CodeModeParseError) return "parse_error";

  if (isToolDispatchError(error)) return error.code;
  if (hasDispatchToken(error, dispatchToken)) {
    const code = ownDataField(error, "code");
    if (isToolDispatchCode(code)) return code;
  }
  return "internal_error";
}

function hasDispatchToken(
  error: unknown,
  dispatchToken: string | undefined
): error is { readonly code?: unknown; readonly __tackDispatchToken?: unknown } {
  return typeof error === "object" && error !== null &&
    typeof dispatchToken === "string" &&
    ownDataField(error, "__tackDispatchToken") === dispatchToken;
}

function ownDataField(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

export function publicExecutionErrorMessage(error: unknown): string {
  return errorMessage(error);
}
