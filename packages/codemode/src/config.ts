import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TackConfig } from "@cbxss/tack-core";
import type { ToolAuditEvent } from "./invoker.js";
import type { OperationPolicy } from "./policy.js";

export function createOperationPolicy(config: TackConfig): OperationPolicy | undefined {
  const security = config.security;
  if (!security?.allowedOperations && !security?.deniedOperations) return undefined;
  return {
    ...(security.allowedOperations ? { allowedOperations: security.allowedOperations } : {}),
    ...(security.deniedOperations ? { deniedOperations: security.deniedOperations } : {})
  };
}

/** The configured JSONL sink shared by CLI and direct SDK invocation. */
export function createAuditSink(config: TackConfig): ((event: ToolAuditEvent) => Promise<void>) | undefined {
  const path = config.security?.auditLog?.path;
  if (!path) return undefined;
  return async event => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
  };
}
