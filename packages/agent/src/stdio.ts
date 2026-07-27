import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import {
  ownDataValue as readOwnData,
  type TackManifest,
  type TackRuntime
} from "@tack/core";
import type { CodeRuntime, OperationPolicy, ToolAuditEvent } from "@tack/codemode";

import { createTackAgentServer } from "./server.js";

export interface ServeTackMcpStdioOptions {
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly codeRuntime: CodeRuntime;
  readonly policy?: OperationPolicy | undefined;
  readonly onAuditEvent?: ((event: ToolAuditEvent) => void | Promise<void>) | undefined;
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
  const manifest = readOwnData(options, "manifest") as TackManifest;
  const runtime = readOwnData(options, "runtime") as TackRuntime;
  const codeRuntime = readOwnData(options, "codeRuntime") as CodeRuntime;
  const policy = readOwnData(options, "policy") as OperationPolicy | undefined;
  const onAuditEvent = readOwnData(options, "onAuditEvent") as ServeTackMcpStdioOptions["onAuditEvent"];

  return {
    manifest,
    runtime,
    codeRuntime,
    ...(policy ? { policy } : {}),
    ...(onAuditEvent ? { onAuditEvent } : {})
  };
}
