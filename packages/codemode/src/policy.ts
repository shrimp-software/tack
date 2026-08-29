import { sanitizeData, type TackOperation } from "@tack/core";

export interface OperationPolicy {
  readonly allowedOperations?: readonly string[] | undefined;
  readonly deniedOperations?: readonly string[] | undefined;
  readonly allOf?: readonly OperationPolicy[] | undefined;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reason?: string | undefined;
}

export function isOperationAllowed(
  operation: TackOperation,
  policy: OperationPolicy | undefined
): PolicyDecision {
  // The trust boundary: a policy may come from config or per-user overrides.
  // Snapshot it once (cycles broken), then walk plain fields.
  return decide(operation, sanitizeData(policy, {}) as OperationPolicy | undefined);
}

function decide(operation: TackOperation, policy: OperationPolicy | undefined): PolicyDecision {
  if (!policy) {
    return { allowed: true };
  }

  for (const child of Array.isArray(policy.allOf) ? policy.allOf : []) {
    const decision = decide(operation, child);
    if (!decision.allowed) {
      return decision;
    }
  }

  if (matchesAny(operation, Array.isArray(policy.deniedOperations) ? policy.deniedOperations : [])) {
    return {
      allowed: false,
      reason: `Operation denied by policy: ${operation.fullPathString}`
    };
  }

  const allowed = Array.isArray(policy.allowedOperations) ? policy.allowedOperations : [];
  if (allowed.length > 0 && !matchesAny(operation, allowed)) {
    return {
      allowed: false,
      reason: `Operation not allowed by policy: ${operation.fullPathString}`
    };
  }

  return { allowed: true };
}

export function filterAllowedOperations(
  operations: readonly TackOperation[],
  policy: OperationPolicy | undefined
): TackOperation[] {
  return operations.filter((operation) => isOperationAllowed(operation, policy).allowed);
}

function matchesAny(
  operation: TackOperation,
  patterns: readonly unknown[]
): boolean {
  return patterns.some((pattern) =>
    typeof pattern === "string" && matchesOperation(operation, pattern)
  );
}

function matchesOperation(operation: TackOperation, pattern: string): boolean {
  const candidates = [
    operation.fullPathString,
    operation.pathString,
    operation.toolId,
    operation.serverId,
    `${operation.serverId}.*`,
    `${operation.namespaceName}.*`
  ];
  return candidates.some((candidate) => globMatches(candidate, pattern));
}

function globMatches(value: string, pattern: string): boolean {
  if (pattern === "*") {
    return true;
  }

  const regexp = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return regexp.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
