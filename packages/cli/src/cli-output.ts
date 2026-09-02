import { formatTackError } from "@cbxss/tack-core";

const stripRepeatedErrorPrefix = (input: string): string => {
  let output = input.trim();
  while (output.toLowerCase().startsWith("error:")) {
    output = output.slice("error:".length).trimStart();
  }
  return output;
};

export function sanitizeCliOutputText(input: string): string {
  return input
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b[@-_][0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

export function normalizeCliErrorText(raw: string): string {
  const lines = raw.split(/\r?\n/u);
  const compacted: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (compacted.length > 0 && compacted.at(-1) !== "") {
        compacted.push("");
      }
      continue;
    }
    if (/^at\s+/u.test(trimmed)) {
      continue;
    }
    if (/^From previous event/u.test(trimmed)) {
      continue;
    }
    compacted.push(trimmed);
  }

  if (compacted.length === 0) {
    return stripRepeatedErrorPrefix(raw);
  }

  compacted[0] = stripRepeatedErrorPrefix(compacted[0] ?? "");
  while (compacted.length > 0 && compacted[0]?.length === 0) {
    compacted.shift();
  }

  return compacted.slice(0, 24).join("\n").trim();
}

export function formatCliError(error: unknown): string {
  const formatted = formatTackError(error);
  const sanitized = sanitizeCliOutputText(formatted);
  const normalized = normalizeCliErrorText(sanitized);
  return normalized.length > 0 ? normalized : "Unknown error";
}
