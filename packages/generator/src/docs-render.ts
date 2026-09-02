import { compileSchema } from "@tack/sdk-types";

import { markdownCodeBlock, markdownInlineCode } from "./markdown.js";
import { groupMethodsByServer, plannedOperations, toGeneratedMethods } from "./methods.js";
import type { GeneratedMethod } from "./types.js";
import type { TackManifest } from "@tack/core";

export async function renderDocs(options: {
  readonly manifest: TackManifest;
  readonly title?: string | undefined;
}): Promise<string> {
  const methods = toGeneratedMethods(plannedOperations(options.manifest));
  const grouped = groupMethodsByServer(methods);
  const lines: string[] = [
    `# ${options.title ?? "Tack Tool Docs"}`,
    "",
    `Operations: ${methods.length}`,
    ""
  ];

  for (const [namespaceName, namespaceOperations] of grouped) {
    lines.push(`## ${namespaceName}`, "");

    for (const operation of namespaceOperations) {
      lines.push(...await renderOperationDocs(operation), "");
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

async function renderOperationDocs(operation: GeneratedMethod): Promise<string[]> {
  const context = { context: "generated SDK types" };
  const inputTypeScript = await compileSchema(operation.inputSchema, operation.inputType, context);
  const outputTypeScript = operation.outputSchema
    ? await compileSchema(operation.outputSchema, operation.outputType, context)
    : `export type ${operation.outputType} = unknown;\n`;
  const lines = [
    `### \`${operation.fullPathString}\``,
    "",
    ...(operation.description ? [operation.description, ""] : []),
    `- Tool ID: ${markdownInlineCode(operation.toolId)}`,
    `- Upstream: ${markdownInlineCode(operation.upstreamName)}`
  ];

  if (operation.injectedArgs) {
    lines.push(`- Injected args: ${markdownInlineCode(JSON.stringify(operation.injectedArgs))}`);
  }

  lines.push(
    "",
    "Examples:",
    "",
    ...markdownCodeBlock("ts", operation.examples),
    "",
    "Input:",
    "",
    ...markdownCodeBlock("ts", inputTypeScript.trim().split("\n")),
    "",
    "Output:",
    "",
    ...markdownCodeBlock("ts", outputTypeScript.trim().split("\n"))
  );

  return lines;
}
