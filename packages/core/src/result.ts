import { ownDataValue as ownValue, ownDataValues } from "./own-data.js";
import type { TackResult } from "./types.js";

function extractText(raw: unknown): string {
  const rawObject = objectRecord(raw);
  if (!rawObject) {
    return "";
  }

  const content = ownValue<unknown>(rawObject, "content");
  if (!Array.isArray(content)) {
    return "";
  }

  return ownDataValues<unknown>(content)
    .flatMap((part) => {
      const partObject = objectRecord(part);
      const type = ownValue<unknown>(partObject, "type");
      const text = ownValue<unknown>(partObject, "text");
      if (
        type === "text" &&
        typeof text === "string"
      ) {
        return [text];
      }

      return [];
    })
    .join("\n");
}

export function createTackResult<TStructured = unknown>(raw: unknown): TackResult<TStructured> {
  const rawObject = objectRecord(raw);
  const structuredContent = ownValue<TStructured>(rawObject, "structuredContent");
  const text = extractText(raw);

  return {
    raw,
    isError:
      ownValue<unknown>(rawObject, "isError") === true,
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

function objectRecord(value: unknown): object | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}
