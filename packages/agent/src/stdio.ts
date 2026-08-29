import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import {
  ownField,
  type TackManifest,
  type TackRuntime
} from "@tack/core";
import type { CodeRuntime, OperationPolicy, ToolAuditEvent } from "@tack/codemode";

import { createTackAgentServer } from "./server.js";
import type { DelegateOptions } from "./delegate.js";

export interface ServeTackMcpStdioOptions {
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly codeRuntime: CodeRuntime;
  readonly policy?: OperationPolicy | undefined;
  readonly onAuditEvent?: ((event: ToolAuditEvent) => void | Promise<void>) | undefined;
  readonly delegate?: DelegateOptions | undefined;
}

export function serveTackMcpStdio(
  options: ServeTackMcpStdioOptions
): StdioServerHandle {
  const context = normalizeServeOptions(options);
  return serveStdio(() => createTackAgentServer(context));
}

function normalizeServeOptions(
  options: ServeTackMcpStdioOptions
): ServeTackMcpStdioOptions {
  const manifest = ownField(options, "manifest") as TackManifest;
  const runtime = ownField(options, "runtime") as TackRuntime;
  const codeRuntime = ownField(options, "codeRuntime") as CodeRuntime;
  const policy = ownField(options, "policy") as OperationPolicy | undefined;
  const onAuditEvent = ownField(options, "onAuditEvent") as ServeTackMcpStdioOptions["onAuditEvent"];
  const delegate = ownField(options, "delegate") as ServeTackMcpStdioOptions["delegate"];

  return {
    manifest,
    runtime,
    codeRuntime,
    ...(policy ? { policy } : {}),
    ...(onAuditEvent ? { onAuditEvent } : {}),
    ...(delegate ? { delegate } : {})
  };
}
