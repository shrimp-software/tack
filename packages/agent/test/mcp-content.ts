/** Concatenate the text of every `text` content block in an MCP tool result. */
export function extractText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content.flatMap((part) => (isTextBlock(part) ? [part.text] : [])).join("\n");
}

function isTextBlock(part: unknown): part is { readonly type: "text"; readonly text: string } {
  return (
    typeof part === "object" &&
    part !== null &&
    !Array.isArray(part) &&
    (part as { readonly type?: unknown }).type === "text" &&
    typeof (part as { readonly text?: unknown }).text === "string"
  );
}

