import { randomUUID } from "node:crypto";
import {
  ownDataValue as readOwnData,
  type TackManifest,
  type TackRuntime
} from "@tack/core";

import { createTackToolInvoker } from "./invoker.js";
import { createExecuteDescription } from "./guide.js";
import type { OperationPolicy } from "./policy.js";
import { renderToolsPrelude } from "./tools.js";
import type {
  CodeRuntime,
  ExecutionResult,
  ExecutionTrace,
  ToolTraceEvent,
  TraceSink
} from "./types.js";

export interface CreateExecutionEngineOptions {
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly codeRuntime: CodeRuntime;
  readonly policy?: OperationPolicy | undefined;
  readonly onAuditEvent?: Parameters<typeof createTackToolInvoker>[0]["onAuditEvent"];
  /** Live trace sink — receives every tool/builtin event as the execution runs. */
  readonly onTrace?: TraceSink | undefined;
}

export interface ExecutionEngine {
  getDescription(): string;
  execute(code: string, signal?: AbortSignal): Promise<ExecutionResult>;
}

export function createExecutionEngine(
  options: CreateExecutionEngineOptions
): ExecutionEngine {
  const manifest = readOwnData(options, "manifest") as TackManifest;
  const runtime = readOwnData(options, "runtime") as TackRuntime;
  const codeRuntime = normalizeCodeRuntime(readOwnData(options, "codeRuntime") as CodeRuntime);
  const policy = readOwnData(options, "policy") as OperationPolicy | undefined;
  const onAuditEvent = readOwnData(options, "onAuditEvent") as CreateExecutionEngineOptions["onAuditEvent"];
  const onTrace = readOwnData(options, "onTrace") as TraceSink | undefined;

  return {
    getDescription: () => createExecuteDescription(manifest, policy),
    execute: async (code, signal) => {
      const executionId = randomUUID();
      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();
      const traceEvents: ToolTraceEvent[] = [];
      const invoker = createTackToolInvoker({
        manifest,
        runtime,
        executionId,
        ...(policy ? { policy } : {}),
        onTraceEvent: (event) => {
          traceEvents.push(event);
          if (onTrace) {
            queueMicrotask(() => onTrace(event));
          }
        },
        ...(onAuditEvent ? { onAuditEvent } : {})
      });

      const result = await codeRuntime.execute({
        code,
        invoker,
        toolsPrelude: renderToolsPrelude()
      }, signal);
      return {
        ...result,
        executionId,
        trace: summarizeTrace({
          runtime: codeRuntime,
          startedAt,
          startedAtMs,
          events: traceEvents
        })
      };
    }
  };
}

function normalizeCodeRuntime(runtime: CodeRuntime): CodeRuntime {
  const name = readOwnData(runtime, "name");
  const isolation = readOwnData(runtime, "isolation");
  const timeoutMs = readOwnData(runtime, "timeoutMs");
  const execute = readOwnData(runtime, "execute");
  if (typeof execute !== "function") {
    throw new TypeError("Code runtime execute is required");
  }

  return {
    name: typeof name === "string" ? name : "unknown",
    isolation: isolation === "process" || isolation === "vm" ? isolation : "none",
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    execute: (input, signal) => execute.call(runtime, input, signal) as ReturnType<CodeRuntime["execute"]>
  };
}

function summarizeTrace(input: {
  readonly runtime: CodeRuntime;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly events: readonly ToolTraceEvent[];
}): ExecutionTrace {
  const operations = input.events.filter((event) => event.type === "tool_call");
  return {
    runtime: input.runtime.name,
    isolation: input.runtime.isolation,
    startedAt: input.startedAt,
    durationMs: Date.now() - input.startedAtMs,
    toolCalls: operations.length,
    deniedToolCalls: operations.filter((event) => !event.allowed).length,
    failedToolCalls: operations.filter((event) => event.ok === false).length,
    builtinCalls: input.events.filter((event) => event.type === "builtin_call"),
    operations
  };
}
