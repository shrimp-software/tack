import {
  createTackResult,
  formatTackError,
  TackRuntimeError,
  type TackConfig,
  type TackResult,
  type TackRuntime,
  type TackRuntimeInvokeOptions,
  type TackTool
} from "@cbxss/tack-core";

import { isTackTool, type TackToolDefinition } from "../define.js";
import { importModule } from "./discover.js";

interface ModuleToolMeta {
  readonly entry: string;
  readonly upstreamName: string;
}

export interface CreateModuleRuntimeOptions {
  readonly config: TackConfig;
  readonly tools: readonly TackTool[];
}

/**
 * A `TackRuntime` for a known-good set of `module`-transport tools. Each tool's
 * source file is imported once and cached.
 */
export function createModuleRuntime(options: CreateModuleRuntimeOptions): TackRuntime {
  const toolsById = indexModuleTools(options.config, options.tools);
  const definitionsByEntry = new Map<string, Promise<Map<string, TackToolDefinition>>>();
  let closed = false;

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
      args: unknown,
      options?: TackRuntimeInvokeOptions
    ): Promise<TackResult<TStructured>> => {
      if (closed) {
        throw new TackRuntimeError({ message: "Module runtime is closed" });
      }
      const meta = toolsById.get(toolId);
      if (!meta) {
        throw new TackRuntimeError({ message: `Unknown Tack tool: ${toolId}`, toolId });
      }
      if (options?.signal?.aborted) {
        throw options.signal.reason ?? new Error("Module tool invocation was cancelled");
      }

      const definition = (await loadDefinitions(meta.entry)).get(meta.upstreamName);
      if (options?.signal?.aborted) {
        throw options.signal.reason ?? new Error("Module tool invocation was cancelled");
      }
      if (!definition) {
        throw new TackRuntimeError({
          message: `Module source no longer exports tool ${meta.upstreamName}`,
          toolId
        });
      }

      try {
        const output = await definition.handler(definition.parse(args ?? {}), {
          signal: options?.signal
        });
        return createTackResult<TStructured>(successEnvelope(output));
      } catch (cause) {
        if (options?.signal?.aborted) {
          throw options.signal.reason ?? cause;
        }
        return createTackResult<TStructured>(failureEnvelope(cause));
      }
    },
    close: async (): Promise<void> => {
      closed = true;
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

function indexModuleTools(
  config: TackConfig,
  tools: readonly TackTool[]
): Map<string, ModuleToolMeta> {
  const byId = new Map<string, ModuleToolMeta>();
  for (const tool of tools) {
    const server = config.servers[tool.serverId];
    if (server?.transport === "module") {
      byId.set(tool.id, { entry: server.entry, upstreamName: tool.upstreamName });
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
  return { isError: true, content: [textBlock(formatTackError(cause))] };
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
