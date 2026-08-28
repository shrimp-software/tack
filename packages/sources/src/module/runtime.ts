import {
  createTackResult,
  ownDataEntries,
  ownDataValue as ownValue,
  TackRuntimeError,
  type TackManifest,
  type TackManifestServer,
  type TackResult,
  type TackRuntime,
  type TackTool
} from "@tack/core";

import { isTackTool, type TackToolDefinition } from "../define.js";
import { importModule } from "./discover.js";

interface ModuleToolMeta {
  readonly entry: string;
  readonly upstreamName: string;
}

export interface CreateModuleRuntimeOptions {
  readonly manifest: TackManifest;
}

/**
 * A `TackRuntime` that resolves `module`-transport tools by importing their
 * source file and calling the matching `defineTool()` handler. Tools from other
 * transports are not its concern and throw `Unknown Tack tool`.
 */
export function createModuleRuntime(options: CreateModuleRuntimeOptions): TackRuntime {
  const manifest = ownValue<TackManifest>(options, "manifest") as TackManifest;
  const toolsById = indexModuleTools(manifest);
  const definitionsByEntry = new Map<string, Promise<Map<string, TackToolDefinition>>>();

  const loadDefinitions = (entry: string): Promise<Map<string, TackToolDefinition>> => {
    const cached = definitionsByEntry.get(entry);
    if (cached) {
      return cached;
    }

    const pending = importModule(entry)
      .then(collectDefinitions)
      .catch((error: unknown) => {
        if (definitionsByEntry.get(entry) === pending) {
          definitionsByEntry.delete(entry);
        }
        throw error;
      });
    definitionsByEntry.set(entry, pending);
    return pending;
  };

  return {
    invoke: async <TStructured = unknown>(
      toolId: string,
      args: unknown
    ): Promise<TackResult<TStructured>> => {
      const meta = toolsById.get(toolId);
      if (!meta) {
        throw new TackRuntimeError({ message: `Unknown Tack tool: ${toolId}`, toolId });
      }

      const definition = (await loadDefinitions(meta.entry)).get(meta.upstreamName);
      if (!definition) {
        throw new TackRuntimeError({
          message: `Module source no longer exports tool ${meta.upstreamName}`,
          toolId
        });
      }

      try {
        const output = await definition.handler(definition.parse(args ?? {}));
        return createTackResult<TStructured>(successEnvelope(output));
      } catch (cause) {
        return createTackResult<TStructured>(failureEnvelope(cause));
      }
    },
    close: async (): Promise<void> => {
      definitionsByEntry.clear();
    }
  };
}

function collectDefinitions(namespace: Record<string, unknown>): Map<string, TackToolDefinition> {
  const definitions = new Map<string, TackToolDefinition>();
  for (const value of Object.values(namespace)) {
    if (isTackTool(value)) {
      definitions.set(value.name, value);
    }
  }
  return definitions;
}

function indexModuleTools(manifest: TackManifest): Map<string, ModuleToolMeta> {
  const entryByServer = new Map<string, string>();
  for (const [serverId, server] of ownDataEntries<TackManifestServer>(
    ownValue<TackManifest["servers"]>(manifest, "servers")
  )) {
    if (server.transport === "module" && server.entry !== undefined) {
      entryByServer.set(serverId, server.entry);
    }
  }

  const byId = new Map<string, ModuleToolMeta>();
  for (const [toolId, tool] of ownDataEntries<TackTool>(
    ownValue<TackManifest["tools"]>(manifest, "tools")
  )) {
    const entry = entryByServer.get(tool.serverId);
    if (entry !== undefined) {
      byId.set(toolId, { entry, upstreamName: tool.upstreamName });
    }
  }
  return byId;
}

/**
 * The minimal MCP-style result shape {@link createTackResult} reads: a text
 * content block, optional structured payload, and an error flag.
 */
interface CallEnvelope {
  readonly isError: boolean;
  readonly structuredContent?: unknown;
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
}

function successEnvelope(value: unknown): CallEnvelope {
  if (value === undefined) {
    return { isError: false, content: [textBlock("")] };
  }
  return {
    isError: false,
    structuredContent: value,
    content: [textBlock(renderText(value))]
  };
}

function failureEnvelope(cause: unknown): CallEnvelope {
  const message = cause instanceof Error ? cause.message : String(cause);
  return { isError: true, content: [textBlock(message)] };
}

function textBlock(text: string): { readonly type: "text"; readonly text: string } {
  return { type: "text", text };
}

function renderText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
