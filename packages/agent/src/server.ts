import { Buffer } from "node:buffer";
import { isSpecType, McpServer, type ContentBlock } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  ownDataValue as readOwnData,
  type TackManifest,
  type TackRuntime
} from "@tack/core";
import {
  createExecutionEngine,
  findGuide,
  renderGuideIndex,
  type CodeRuntime,
  type ExecutionResult,
  type OperationPolicy
} from "@tack/codemode";
import type { ToolAuditEvent } from "@tack/codemode";

export interface CreateTackAgentServerOptions {
  readonly manifest: TackManifest;
  readonly runtime: TackRuntime;
  readonly codeRuntime: CodeRuntime;
  readonly policy?: OperationPolicy | undefined;
  readonly onAuditEvent?: ((event: ToolAuditEvent) => void | Promise<void>) | undefined;
}

export function createTackAgentServer(
  options: CreateTackAgentServerOptions
): McpServer {
  const manifest = readOwnData(options, "manifest") as TackManifest;
  const runtime = readOwnData(options, "runtime") as TackRuntime;
  const codeRuntime = readOwnData(options, "codeRuntime") as CodeRuntime;
  const policy = readOwnData(options, "policy") as OperationPolicy | undefined;
  const onAuditEvent = readOwnData(options, "onAuditEvent") as CreateTackAgentServerOptions["onAuditEvent"];
  const engine = createExecutionEngine({
    manifest,
    runtime,
    codeRuntime,
    ...(policy ? { policy } : {}),
    ...(onAuditEvent ? { onAuditEvent } : {})
  });
  const server = new McpServer(
    { name: "tack", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "execute",
    {
      title: "Execute Tack code",
      description: engine.getDescription(),
      inputSchema: z.object({
        code: z.string().trim().min(1)
      })
    },
    async ({ code }) => {
      try {
        return formatExecuteMcpResult(await engine.execute(code));
      } catch {
        return formatExecuteMcpResult({
          ok: false,
          emitted: [],
          logs: [],
          error: {
            phase: "runtime",
            message: "Internal execute error"
          }
        });
      }
    }
  );

  server.registerTool(
    "guide",
    {
      title: "Fetch Tack guide",
      description: [
        "Fetch a named how-to guide. Guides hold long-form guidance that would otherwise bloat another tool's always-loaded description.",
        'Call `guide({ name: "execute" })` for the full guide to writing code for the execute tool.',
        "Call with no name to list available guides."
      ].join("\n"),
      inputSchema: z.object({
        name: z.string().optional().describe('The guide to fetch, e.g. "execute". Omit to list available guides.')
      })
    },
    async ({ name }) => {
      const trimmed = name?.trim();
      if (!trimmed) {
        return {
          content: [{ type: "text", text: renderGuideIndex() }]
        };
      }

      const guide = findGuide(trimmed, manifest, policy);
      if (!guide) {
        return {
          content: [{ type: "text", text: `No guide named "${trimmed}".\n\n${renderGuideIndex()}` }],
          isError: true
        };
      }

      return {
        content: [{ type: "text", text: guide.body }]
      };
    }
  );

  return server;
}

const MAX_PREVIEW_CHARS = 30_000;
const TEXT_FILE_CONTENT_MAX_CHARS = 64_000;
const TEXT_FILE_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/yaml",
  "application/x-yaml"
]);

interface ToolFileValue {
  readonly _tag: "ToolFile";
  readonly name?: string | undefined;
  readonly mimeType: string;
  readonly encoding: "base64";
  readonly data: string;
  readonly byteLength: number;
}

type ExecuteMcpStructuredContent =
  | {
    readonly status: "completed";
    readonly result: unknown;
    readonly emitted?: number | undefined;
    readonly logs: readonly string[];
  }
  | {
    readonly status: "error";
    readonly error: NonNullable<ExecutionResult["error"]>;
    readonly emitted?: number | undefined;
    readonly logs: readonly string[];
  };

function formatExecuteMcpResult(result: ExecutionResult): {
  readonly content: ContentBlock[];
  readonly structuredContent: ExecuteMcpStructuredContent;
  readonly isError?: true;
} {
  const content = result.emitted.flatMap(emittedContent);
  const text = executionText(result, content.length);
  if (text) {
    content.push({ type: "text", text });
  }

  return {
    content: content.length > 0 ? content : [{ type: "text", text: "(no result)" }],
    structuredContent: executeStructuredContent(result),
    ...(result.ok ? {} : { isError: true as const })
  };
}

function executeStructuredContent(result: ExecutionResult): ExecuteMcpStructuredContent {
  const emitted = result.emitted.length > 0 ? { emitted: result.emitted.length } : {};
  if (!result.ok) {
    return {
      status: "error",
      error: result.error ?? {
        phase: "runtime",
        message: "Execution failed"
      },
      ...emitted,
      logs: result.logs
    };
  }

  return {
    status: "completed",
    result: "result" in result ? result.result ?? null : null,
    ...emitted,
    logs: result.logs
  };
}

function emittedContent(value: unknown): ContentBlock[] {
  if (isSpecType.ContentBlock(value)) {
    return [value];
  }

  if (isToolFile(value)) {
    return toolFileContent(value);
  }

  return [{ type: "text", text: truncatePreview(valueText(value), MAX_PREVIEW_CHARS, previewSuffix) }];
}

function executionText(result: ExecutionResult, emittedCount: number): string | undefined {
  const parts: string[] = [];
  if (result.error) {
    parts.push(truncatePreview(`Error: ${result.error.phase}: ${result.error.message}`, MAX_PREVIEW_CHARS, previewSuffix));
  } else if (emittedCount === 0 && "result" in result) {
    parts.push(truncatePreview(valueText(result.result), MAX_PREVIEW_CHARS, previewSuffix));
  } else if (emittedCount === 0) {
    parts.push("(no result)");
  }

  if (result.logs.length > 0) {
    parts.push(`Logs:\n${truncatePreview(result.logs.join("\n"), MAX_PREVIEW_CHARS, previewSuffix)}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function valueText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncatePreview(text: string, maxChars: number, suffix: (truncatedChars: number) => string): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}${suffix(text.length - maxChars)}`
    : text;
}

function previewSuffix(truncatedChars: number): string {
  return `\n... [truncated ${truncatedChars} chars]`;
}

function textFileSuffix(truncatedChars: number): string {
  return `\n\n[truncated ${truncatedChars} characters]`;
}

function isToolFile(value: unknown): value is ToolFileValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const file = value as {
    readonly _tag?: unknown;
    readonly mimeType?: unknown;
    readonly encoding?: unknown;
    readonly data?: unknown;
    readonly byteLength?: unknown;
  };
  return file._tag === "ToolFile" &&
    typeof file.mimeType === "string" &&
    file.encoding === "base64" &&
    typeof file.data === "string" &&
    typeof file.byteLength === "number" &&
    Number.isFinite(file.byteLength) &&
    file.byteLength >= 0;
}

function toolFileContent(file: ToolFileValue): ContentBlock[] {
  return [
    { type: "text", text: `File output: ${toolFileSummary(file)}` },
    ...toolFileDataContent(file)
  ];
}

function toolFileDataContent(file: ToolFileValue): ContentBlock[] {
  const mimeType = normalizedMimeType(file);
  if (mimeType.startsWith("image/")) {
    return [{ type: "image", data: file.data, mimeType: file.mimeType }];
  }

  if (mimeType.startsWith("audio/")) {
    return [{ type: "audio", data: file.data, mimeType: file.mimeType }];
  }

  if (isTextMimeType(mimeType)) {
    return [{ type: "text", text: decodeTextFile(file) }];
  }

  return [
    {
      type: "resource",
      resource: {
        uri: `tack-file:///${encodeURIComponent(file.name ?? "tool-output")}`,
        mimeType: file.mimeType,
        blob: file.data
      }
    }
  ];
}

function toolFileSummary(file: ToolFileValue): string {
  return `${file.name ?? "tool-output"} (${file.mimeType}, ${file.byteLength} bytes)`;
}

function normalizedMimeType(file: ToolFileValue): string {
  return file.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith("text/") ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml") ||
    TEXT_FILE_MIME_TYPES.has(mimeType);
}

function decodeTextFile(file: ToolFileValue): string {
  const text = Buffer.from(file.data, "base64").toString("utf8");
  return truncatePreview(text, TEXT_FILE_CONTENT_MAX_CHARS, textFileSuffix);
}
