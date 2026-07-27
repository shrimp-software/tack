import {
  ownDataValue as ownValue,
  ownDataValues,
  type TackOperation
} from "@tack/core";

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
  return isOperationAllowedWithSeen(operation, policy, new WeakSet<object>());
}

function isOperationAllowedWithSeen(
  operation: TackOperation,
  policy: OperationPolicy | undefined,
  seen: WeakSet<object>
): PolicyDecision {
  if (!policy) {
    return { allowed: true };
  }

  if (seen.has(policy)) {
    return { allowed: true };
  }
  seen.add(policy);

  const allOf = ownValue<unknown>(policy, "allOf");
  for (const child of Array.isArray(allOf) ? ownDataValues<OperationPolicy>(allOf) : []) {
    const decision = isOperationAllowedWithSeen(operation, child, seen);
    if (!decision.allowed) {
      return decision;
    }
  }

  const deniedOperations = ownValue<unknown>(policy, "deniedOperations");
  if (matchesAny(operation, Array.isArray(deniedOperations) ? deniedOperations : [])) {
    return {
      allowed: false,
      reason: `Operation denied by policy: ${operation.fullPathString}`
    };
  }

  const allowedOperations = ownValue<unknown>(policy, "allowedOperations");
  const allowed = Array.isArray(allowedOperations) ? allowedOperations : [];
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
  return ownDataValues<unknown>(patterns).some((pattern) =>
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
