import { ownField } from "@cbxss/tack-core";
import type { ExecutionResult, ToolInvoker } from "./types.js";

export interface NormalizedCodeRuntimeExecuteInput {
  readonly code: string;
  readonly invoker: ToolInvoker;
  readonly toolsPrelude: string;
}

export type NormalizeCodeRuntimeExecuteInputResult =
  | {
    readonly ok: true;
    readonly value: NormalizedCodeRuntimeExecuteInput;
  }
  | {
    readonly ok: false;
    readonly result: ExecutionResult;
  };

export interface RenderCodeModeUserFunctionSourceInput {
  readonly code: string;
  readonly toolsPrelude: string;
  readonly fetchErrorMessage: string;
  readonly strict?: boolean;
  /**
   * Session mode: give the wrapper a `__scope` parameter so a caller can pass a
   * persistent scope object. `code` is expected to be already scope-rewritten.
   */
  readonly scopeParam?: boolean;
}

export function normalizeCodeRuntimeExecuteInput(input: unknown): NormalizeCodeRuntimeExecuteInputResult {
  const code = ownField(input, "code");
  if (typeof code !== "string") {
    return { ok: false, result: invalidInputResult("code is required") };
  }

  const toolsPrelude = ownField(input, "toolsPrelude");
  if (typeof toolsPrelude !== "string") {
    return { ok: false, result: invalidInputResult("toolsPrelude is required") };
  }

  const invoker = ownField(input, "invoker");
  const invoke = ownField(invoker, "invoke");
  if (typeof invoke !== "function") {
    return { ok: false, result: invalidInputResult("tool invoker is required") };
  }

  return {
    ok: true,
    value: {
      code,
      toolsPrelude,
      invoker: {
        invoke: (request) => invoke.call(invoker, request) as ReturnType<ToolInvoker["invoke"]>
      }
    }
  };
}

export function validateCodeModeUserCode(code: string): void {
  const denied = [
    { pattern: /\beval\b/u, label: "eval" },
    { pattern: /\bFunction\s*\(/u, label: "Function constructor" },
    { pattern: /\bnew\s+Function\b/u, label: "Function constructor" },
    { pattern: /\bimport\s*\(/u, label: "dynamic import" },
    { pattern: /\bconstructor\b/u, label: "constructor escape" },
    { pattern: /["']constructor["']/u, label: "constructor escape" },
    { pattern: /\b__proto__\b/u, label: "__proto__ escape" },
    { pattern: /\bprototype\b/u, label: "prototype escape" },
    { pattern: /\bWebAssembly\b/u, label: "WebAssembly" },
    { pattern: /\b__tack[A-Za-z]/u, label: "reserved __tack identifier" },
    { pattern: /\b__scope\b/u, label: "reserved __scope identifier" }
  ];

  const blocked = denied.find(({ pattern }) => pattern.test(code));
  if (blocked) {
    throw new CodeModeParseError(`Unsupported code-mode construct: ${blocked.label}`);
  }
}

export function renderCodeModeUserFunctionSource(input: RenderCodeModeUserFunctionSourceInput): string {
  const scopeParam = input.scopeParam ? ", __scope: Record<string, unknown>" : "";
  return `
async function __tackUser(__tackInvoke: (path: string, args?: unknown) => Promise<unknown>, console: unknown, emit: (value: unknown) => void${scopeParam}) {
${input.strict ? '  "use strict";\n' : ""}${input.toolsPrelude}
  const RUNNER_TOKEN = undefined;
  const USER_CODE = undefined;
  const TIMEOUT_MS = undefined;
  const MAX_OUTPUT_BYTES = undefined;
  const MAX_TOOL_CALLS = undefined;
  const globalThis = undefined;
  const self = undefined;
  const window = undefined;
  const process = undefined;
  const require = undefined;
  const module = undefined;
  const Function = undefined;
  const WebSocket = undefined;
  const fetch = (..._args: unknown[]) => {
    throw new Error(${JSON.stringify(input.fetchErrorMessage)});
  };
${input.code}
}
__tackUser;
`;
}

function invalidInputResult(message: string): ExecutionResult {
  return {
    ok: false,
    emitted: [],
    logs: [],
    error: {
      phase: "parse",
      code: "parse_error",
      message
    }
  };
}

export class CodeModeParseError extends Error {}
