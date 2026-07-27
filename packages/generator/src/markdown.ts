export function markdownInlineCode(value: string): string {
  const fence = "`".repeat(maxBacktickRun([value]) + 1);
  const needsPadding = value.startsWith("`") || value.endsWith("`");
  return needsPadding ? `${fence} ${value} ${fence}` : `${fence}${value}${fence}`;
}

export function markdownCodeBlock(language: string, lines: readonly string[]): string[] {
  const fence = "`".repeat(Math.max(3, maxBacktickRun(lines) + 1));
  return [`${fence}${language}`, ...lines, fence];
}

function maxBacktickRun(lines: readonly string[]): number {
  return Math.max(0, ...lines.map((line) =>
    Math.max(0, ...[...line.matchAll(/`+/gu)].map((match) => match[0].length))
  ));
}
