import {
  assignOperationTypeNames,
  listOperations,
  type TackManifest,
  type TackOperation
} from "@tack/core";

import type { GeneratedMethod } from "./types.js";

export function plannedOperations(manifest: TackManifest): TackOperation[] {
  return listOperations(manifest).sort((left, right) =>
    left.fullPathString.localeCompare(right.fullPathString)
  );
}

export function toGeneratedMethods(operations: readonly TackOperation[]): GeneratedMethod[] {
  const typeNames = assignOperationTypeNames(operations);
  return operations.map((operation) => {
    const names = typeNames.get(operation.fullPathString);
    if (!names) {
      throw new Error(`No type names assigned for operation ${operation.fullPathString}`);
    }
    return {
      namespaceName: operation.namespaceName,
      serverId: operation.serverId,
      path: operation.path,
      pathString: operation.pathString,
      fullPathString: operation.fullPathString,
      toolId: operation.toolId,
      upstreamName: operation.upstreamName,
      ...(operation.description ? { description: operation.description } : {}),
      examples: operation.examples,
      inputSchema: operation.inputSchema,
      ...(operation.outputSchema ? { outputSchema: operation.outputSchema } : {}),
      ...(operation.injectedArgs ? { injectedArgs: operation.injectedArgs } : {}),
      inputType: names.inputType,
      outputType: names.outputType,
      resultType: names.resultType
    };
  });
}

export function groupMethodsByServer(
  methods: readonly GeneratedMethod[]
): Map<string, GeneratedMethod[]> {
  const grouped = new Map<string, GeneratedMethod[]>();
  for (const method of methods) {
    const serverMethods = grouped.get(method.namespaceName) ?? [];
    serverMethods.push(method);
    grouped.set(method.namespaceName, serverMethods);
  }

  return grouped;
}
