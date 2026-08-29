import {
  objectRecord,
  type TackManifest
} from "@tack/core";

import type { GeneratedMethod } from "./types.js";

export function assertSupportedManifest(manifest: TackManifest): void {
  const record = objectRecord(manifest);
  if (!record) {
    throw new Error("Invalid Tack manifest: manifest must be an object");
  }

  const version = record["version"];
  if (version !== "0.1") {
    throw new Error(`Unsupported Tack manifest version: ${String(version)}`);
  }

  if (typeof record["generatedAt"] !== "string") {
    throw new Error("Invalid Tack manifest: generatedAt must be a string");
  }

  const servers = objectRecord(record["servers"]);
  if (!servers) {
    throw new Error("Invalid Tack manifest: servers must be an object");
  }

  const tools = objectRecord(record["tools"]);
  if (!tools) {
    throw new Error("Invalid Tack manifest: tools must be an object");
  }

  for (const [serverId, server] of Object.entries(servers)) {
    if (!objectRecord(server)) {
      throw new Error(`Invalid Tack manifest server entry ${serverId}: server must be an object`);
    }
  }

  for (const [toolId, tool] of Object.entries(tools)) {
    if (!objectRecord(tool)) {
      throw new Error(`Invalid Tack manifest tool entry ${toolId}: tool must be an object`);
    }
  }
}

export function assertSafeGeneratedServerNames(serverNames: Iterable<string>): void {
  for (const name of serverNames) {
    if (!isSafeGeneratedServerName(name)) {
      throw new Error(`Unsafe generated SDK server module name: ${name}`);
    }
  }
}

export function assertVisibleManifestToolsArePlannable(manifest: TackManifest): void {
  for (const [entryId, tool] of Object.entries(manifest.tools)) {
    const record = objectRecord(tool);
    if (!record) {
      throw new Error(`Invalid Tack manifest tool entry ${entryId}: tool must be an object`);
    }

    const id = record["id"];
    if (id !== entryId) {
      throw new Error(`Visible manifest tool entry ${entryId} has mismatched id ${String(id)}`);
    }

    const serverId = record["serverId"];
    const namespaceName = record["namespaceName"];
    const sdkName = record["sdkName"];
    const upstreamName = record["upstreamName"];
    const inputSchema = record["inputSchema"];
    if (
      typeof serverId !== "string" ||
      typeof namespaceName !== "string" ||
      typeof sdkName !== "string" ||
      typeof upstreamName !== "string" ||
      !objectRecord(inputSchema)
    ) {
      throw new Error(`Visible manifest tool entry ${entryId} has invalid SDK metadata`);
    }
  }
}

export function assertRuntimeManifestServerCoverage(
  manifest: TackManifest,
  methods: readonly GeneratedMethod[]
): void {
  for (const method of methods) {
    const server = manifest.servers[method.serverId];
    const record = objectRecord(server);
    if (!record) {
      throw new Error(
        `Generated SDK tool ${method.toolId} references missing manifest server ${method.serverId}`
      );
    }

    const id = record["id"];
    const transport = record["transport"];
    const tools = record["tools"];
    const toolIds = Array.isArray(tools)
      ? tools.filter((toolId): toolId is string => typeof toolId === "string")
      : [];
    if (
      id !== method.serverId ||
      !["http", "stdio"].includes(transport as string) ||
      !Array.isArray(tools)
    ) {
      throw new Error(`Generated SDK server ${method.serverId} has invalid manifest metadata`);
    }

    if (!toolIds.includes(method.toolId)) {
      throw new Error(
        `Generated SDK tool ${method.toolId} is not listed by manifest server ${method.serverId}`
      );
    }
  }
}

function isSafeGeneratedServerName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) &&
    !["__proto__", "close", "index", "tack", "types"].includes(name) &&
    !isReservedWindowsFileName(name);
}

function isReservedWindowsFileName(name: string): boolean {
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(name);
}
