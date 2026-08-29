import { ownField, sanitizeData } from "./sanitize.js";
import type { TackResult } from "./types.js";

interface TextContentPart {
  readonly type?: unknown;
  readonly text?: unknown;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part): string[] => {
      const { type, text } = (part ?? {}) as TextContentPart;
      return type === "text" && typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

export function createTackResult<TStructured = unknown>(raw: unknown): TackResult<TStructured> {
  // `structuredContent` is handed back to callers verbatim (a local module tool
  // may legitimately return a Date / Map / class instance), so read it
  // getter-safe but do not deep-copy. `content` is plain MCP text parts, so
  // snapshot it deeply and eagerly — later mutation of `raw` cannot affect us.
  const structuredContent = ownField<TStructured>(raw, "structuredContent");
  const isError = ownField(raw, "isError") === true;
  const text = extractText(sanitizeData(ownField(raw, "content"), {}));

  return {
    raw,
    isError,
    structuredContent,
    text: () => text,
    json: <T = TStructured>() => {
      if (structuredContent !== undefined) {
        return structuredContent as unknown as T;
      }

      if (text.length === 0) {
        throw new Error("Tack result has no structuredContent or text JSON to parse");
      }

      return JSON.parse(text) as T;
    }
  };
}
