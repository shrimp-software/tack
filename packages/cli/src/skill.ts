import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TACK_SKILL_NAME = "tack";

export interface TackSkillFile {
  readonly path: string;
  readonly contents: string;
}

export interface InstallTackSkillOptions {
  readonly force?: boolean | undefined;
}

export function tackSkillFiles(): readonly TackSkillFile[] {
  return [
    {
      path: "SKILL.md",
      contents: tackSkillMarkdown()
    },
    {
      path: "agents/openai.yaml",
      contents: tackSkillOpenAiYaml()
    }
  ];
}

export async function installTackSkill(
  outputDirectory: string,
  options: InstallTackSkillOptions = {}
): Promise<string> {
  const skillDirectory = join(outputDirectory, TACK_SKILL_NAME);
  if (!options.force && await exists(skillDirectory)) {
    throw new Error(`Refusing to overwrite existing skill at ${skillDirectory}. Pass --force to replace it.`);
  }

  for (const file of tackSkillFiles()) {
    const path = join(skillDirectory, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.contents, "utf8");
  }

  return skillDirectory;
}

export function defaultSkillOutputDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ? join(env.CODEX_HOME, "skills") : join(homedir(), ".codex", "skills");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function tackSkillMarkdown(): string {
  return `---
name: tack
description: Work with Tack, the TypeScript/Bun toolchain that turns live MCP servers into agent-friendly TypeScript SDKs, MCP execute/guide tools, and hosted HTTP services. Use when configuring tack.config.json, discovering MCP tools, generating SDK/docs, debugging Tack CLI setup, running Tack MCP hosts, or invoking Tack operations from Codex.
---

# Tack

Use the local \`tack\` CLI as the source of truth. Prefer deterministic CLI commands over manually reconstructing manifests or generated SDK files.

## Workflow

1. Run \`tack doctor\` to validate the CLI environment, config file, and live MCP discovery.
2. Create config with \`tack init\` when \`tack.config.json\` is missing, then edit \`servers\` for the target MCP servers.
3. Inspect available operation paths with \`tack inspect\`.
4. Generate artifacts with \`tack build\`, or use \`tack generate\` and \`tack docs\` separately.
5. Invoke one operation with \`tack call <operation.path> --json '{}'\` when a direct check is enough.
6. Expose agent-facing tools with \`tack mcp\` for stdio or \`tack host --path /mcp\` for Streamable HTTP.
7. Use \`tack serve\` only when \`service.users\` has bearer tokens configured.

## Config Notes

- \`servers\` is required and maps server IDs to \`stdio\` or \`http\` MCP connections.
- Runtime defaults to QuickJS. Use \`runtime.type: "workerd"\` only when process isolation is needed.
- Security policy uses inferred operation paths in \`security.allowedOperations\` and \`security.deniedOperations\`.
- Generated SDK output defaults to \`.tack/generated\`; do not hand-edit generated files.

## Validation

Run project checks after changing Tack itself:

\`\`\`sh
bun run typecheck
bun run test
\`\`\`
`;
}

function tackSkillOpenAiYaml(): string {
  return `display_name: Tack
short_description: Configure and run Tack MCP-to-SDK workflows.
default_prompt: Use Tack to inspect MCP tools, generate SDKs or docs, validate setup, and expose agent-facing MCP tools.
`;
}
