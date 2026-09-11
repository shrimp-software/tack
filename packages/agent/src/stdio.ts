import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import {
  ownField,
  type TackManifest,
  type TackRuntime
} from "@cbxss/tack-core";
import type { CodeRuntime, OperationPolicy, ToolAuditEvent } from "@cbxss/tack-codemode";

import { createTackAgentServer, type CreateTackAgentServerOptions } from "./server.js";

export interface ServeTackMcpStdioOptions {
  readonly stateRoot?: string | undefined;
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly codeRuntime: CodeRuntime;
  readonly policy?: OperationPolicy | undefined;
  readonly onAuditEvent?: ((event: ToolAuditEvent) => void | Promise<void>) | undefined;
  readonly typecheck?: CreateTackAgentServerOptions["typecheck"];
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
  const typecheck = ownField(options, "typecheck") as ServeTackMcpStdioOptions["typecheck"];

  return {
    stateRoot: ownField<string>(options, "stateRoot"),
    manifest,
    runtime,
    codeRuntime,
    ...(policy ? { policy } : {}),
    ...(onAuditEvent ? { onAuditEvent } : {}),
    ...(typecheck ? { typecheck } : {})
  };
}
