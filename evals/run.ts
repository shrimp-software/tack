#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface EvalConfig {
  readonly codex?: CodexConfig | undefined;
  readonly outputDir?: string | undefined;
  readonly cases: readonly string[];
  readonly targets: readonly TargetConfig[];
}

interface CodexConfig {
  readonly bin?: string | undefined;
  readonly model?: string | undefined;
  readonly cd?: string | undefined;
  readonly flags?: readonly string[] | undefined;
  readonly outputSchema?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly envFromProcess?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
}

interface TargetBaseConfig {
  readonly id: string;
  readonly mcpName?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly envFromProcess?: readonly string[] | undefined;
  readonly enabled?: boolean | undefined;
  readonly codex?: CodexConfig | undefined;
}

interface StdioTargetConfig extends TargetBaseConfig {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly url?: never;
}

interface HttpTargetConfig extends TargetBaseConfig {
  readonly url: string;
  readonly bearerTokenEnvVar?: string | undefined;
  readonly oauthClientId?: string | undefined;
  readonly oauthResource?: string | undefined;
  readonly command?: never;
  readonly args?: never;
  readonly cwd?: never;
}

type TargetConfig = StdioTargetConfig | HttpTargetConfig;

interface EvalCase {
  readonly id: string;
  readonly title?: string | undefined;
  readonly prompt: string;
  readonly expectations?: readonly string[] | undefined;
}

interface CodexUsage {
  readonly input_tokens?: number | undefined;
  readonly cached_input_tokens?: number | undefined;
  readonly cache_write_input_tokens?: number | undefined;
  readonly output_tokens?: number | undefined;
  readonly reasoning_output_tokens?: number | undefined;
}

interface TargetRunSummary {
  readonly targetId: string;
  readonly mcpName: string;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly usage: CodexUsage | null;
  readonly finalMessage: string;
  readonly finalJson: unknown;
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly artifacts: {
    readonly stdoutJsonl: string;
    readonly stderr: string;
    readonly finalMessage: string;
  };
}

interface CaseRunSummary {
  readonly runId: string;
  readonly caseId: string;
  readonly createdAt: string;
  readonly targets: readonly TargetRunSummary[];
  readonly comparisons: readonly PairwiseComparison[];
}

interface PairwiseComparison {
  readonly left: string;
  readonly right: string;
  readonly wordJaccard: number;
  readonly inputTokenDelta: number | null;
  readonly outputTokenDelta: number | null;
  readonly durationMsDelta: number;
}

const evalRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(evalRoot);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const configPath = resolvePath(args.config ?? "evals/eval.config.local.json");
  const config = await readJson<EvalConfig>(configPath);
  const casePaths = args.case ? [args.case] : config.cases;
  const targets = config.targets.filter((target) =>
    (!args.target || target.id === args.target) && (target.enabled !== false || args.target === target.id)
  );

  if (targets.length === 0) {
    throw new Error("No enabled eval targets matched the requested filters.");
  }

  const outRoot = resolvePath(config.outputDir ?? "evals/runs");
  await mkdir(outRoot, { recursive: true });

  for (const casePath of casePaths) {
    const evalCase = await readJson<EvalCase>(resolvePath(casePath));
    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${evalCase.id}-${randomUUID().slice(0, 8)}`;
    const caseOutDir = resolve(outRoot, runId);
    await mkdir(caseOutDir, { recursive: true });

    const targetRuns: TargetRunSummary[] = [];
    for (const target of targets) {
      targetRuns.push(await runTarget({
        evalCase,
        target,
        baseCodex: config.codex ?? {},
        outDir: caseOutDir,
        dryRun: args.dryRun
      }));
    }

    const summary: CaseRunSummary = {
      runId,
      caseId: evalCase.id,
      createdAt: new Date().toISOString(),
      targets: targetRuns,
      comparisons: compareTargets(targetRuns)
    };
    await writeJson(resolve(caseOutDir, "summary.json"), summary);
    console.log(JSON.stringify(summary, null, 2));
  }
}

function parseArgs(argv: readonly string[]): {
  readonly config?: string | undefined;
  readonly case?: string | undefined;
  readonly target?: string | undefined;
  readonly dryRun: boolean;
} {
  const parsed: {
    config?: string;
    case?: string;
    target?: string;
    dryRun: boolean;
  } = { dryRun: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--config" || arg === "--case" || arg === "--target") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }

      index += 1;
      if (arg === "--config") {
        parsed.config = value;
      } else if (arg === "--case") {
        parsed.case = value;
      } else {
        parsed.target = value;
      }
      continue;
    }

    throw new Error(`Unknown eval argument: ${arg ?? ""}`);
  }

  return parsed;
}

async function runTarget(input: {
  readonly evalCase: EvalCase;
  readonly target: TargetConfig;
  readonly baseCodex: CodexConfig;
  readonly outDir: string;
  readonly dryRun: boolean;
}): Promise<TargetRunSummary> {
  const targetOutDir = resolve(input.outDir, input.target.id);
  await mkdir(targetOutDir, { recursive: true });

  const codex = mergeCodexConfig(input.baseCodex, input.target.codex ?? {});
  const mcpName = input.target.mcpName ?? input.target.id;
  const prompt = renderPrompt(input.evalCase, mcpName);
  const command = buildCodexCommand({ codex, target: input.target, mcpName, prompt });
  await writeJson(resolve(targetOutDir, "command.json"), {
    command: command.bin,
    args: redactArgs(command.args, command.env),
    envKeys: Object.keys(command.env).sort(),
    promptHash: sha256(prompt)
  });
  await writeFile(resolve(targetOutDir, "prompt.txt"), prompt);

  if (input.dryRun) {
    return {
      targetId: input.target.id,
      mcpName,
      ok: true,
      exitCode: 0,
      durationMs: 0,
      usage: null,
      finalMessage: "",
      finalJson: null,
      eventCounts: {},
      artifacts: artifactPaths(targetOutDir)
    };
  }

  const startedAt = Date.now();
  const result = await runProcess({
    command: command.bin,
    args: command.args,
    cwd: resolvePath(codex.cd ?? "."),
    env: command.env,
    timeoutMs: codex.timeoutMs ?? 240_000
  });
  const durationMs = Date.now() - startedAt;

  const artifacts = artifactPaths(targetOutDir);
  await writeFile(artifacts.stdoutJsonl, result.stdout);
  await writeFile(artifacts.stderr, result.stderr);

  const parsed = parseCodexJsonl(result.stdout);
  await writeFile(artifacts.finalMessage, parsed.finalMessage);
  return {
    targetId: input.target.id,
    mcpName,
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    durationMs,
    usage: parsed.usage,
    finalMessage: parsed.finalMessage,
    finalJson: parseFinalJson(parsed.finalMessage),
    eventCounts: parsed.eventCounts,
    artifacts
  };
}

function buildCodexCommand(input: {
  readonly codex: CodexConfig;
  readonly target: TargetConfig;
  readonly mcpName: string;
  readonly prompt: string;
}): { readonly bin: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> } {
  const flags = input.codex.flags ?? [
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--sandbox",
    "read-only"
  ];
  const args = ["exec", ...flags];
  if (input.codex.model) {
    args.push("--model", input.codex.model);
  }

  if (input.codex.outputSchema) {
    args.push("--output-schema", expandPath(input.codex.outputSchema));
  }

  const targetEnv = {
    ...expandRecord(input.target.env ?? {}),
    ...envFromProcess(input.target.envFromProcess ?? [])
  };

  if (isHttpTarget(input.target)) {
    args.push("-c", `mcp_servers.${input.mcpName}.url=${tomlString(expand(input.target.url))}`);
    if (input.target.bearerTokenEnvVar) {
      args.push(
        "-c",
        `mcp_servers.${input.mcpName}.bearer_token_env_var=${tomlString(input.target.bearerTokenEnvVar)}`
      );
    }
    if (input.target.oauthClientId) {
      args.push(
        "-c",
        `mcp_servers.${input.mcpName}.oauth_client_id=${tomlString(expand(input.target.oauthClientId))}`
      );
    }
    if (input.target.oauthResource) {
      args.push(
        "-c",
        `mcp_servers.${input.mcpName}.oauth_resource=${tomlString(expand(input.target.oauthResource))}`
      );
    }
  } else {
    args.push(
      "-c",
      `mcp_servers.${input.mcpName}.command=${tomlString(expand(input.target.command))}`
    );
    const targetArgs = input.target.args?.map(expand) ?? [];
    if (targetArgs.length > 0) {
      args.push("-c", `mcp_servers.${input.mcpName}.args=${tomlStringArray(targetArgs)}`);
    }

    for (const [key, value] of Object.entries(targetEnv)) {
      args.push("-c", `mcp_servers.${input.mcpName}.env.${key}=${tomlString(value)}`);
    }

    if (input.target.cwd) {
      args.push("-c", `mcp_servers.${input.mcpName}.cwd=${tomlString(expandPath(input.target.cwd))}`);
    }
  }

  if (input.codex.cd) {
    args.push("--cd", expandPath(input.codex.cd));
  }

  const codexEnv = {
    ...expandRecord(input.codex.env ?? {}),
    ...envFromProcess(input.codex.envFromProcess ?? [])
  };

  args.push(input.prompt);
  return {
    bin: input.codex.bin ?? "codex",
    args,
    env: {
      ...codexEnv,
      ...targetEnv
    }
  };
}

function isHttpTarget(target: TargetConfig): target is HttpTargetConfig {
  return typeof target.url === "string";
}

function renderPrompt(evalCase: EvalCase, mcpName: string): string {
  const lines = [
    `Eval case: ${evalCase.id}`,
    evalCase.title ? `Title: ${evalCase.title}` : "",
    "",
    `Use the MCP server named "${mcpName}" as the system under test.`,
    "Do not use other MCP servers or local shell commands for task data.",
    "Capture what the server makes easy or hard, but keep the final answer concise.",
    "",
    "Task:",
    evalCase.prompt
  ].filter(Boolean);

  if (evalCase.expectations && evalCase.expectations.length > 0) {
    lines.push("", "Expectations:", ...evalCase.expectations.map((item) => `- ${item}`));
  }

  return lines.join("\n");
}

function parseCodexJsonl(stdout: string): {
  readonly finalMessage: string;
  readonly usage: CodexUsage | null;
  readonly eventCounts: Readonly<Record<string, number>>;
} {
  let finalMessage = "";
  let usage: CodexUsage | null = null;
  const eventCounts: Record<string, number> = {};

  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }

    let event: {
      readonly type?: string;
      readonly usage?: CodexUsage;
      readonly item?: {
        readonly type?: string;
        readonly text?: string;
      };
    };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      eventCounts["malformed_jsonl"] = (eventCounts["malformed_jsonl"] ?? 0) + 1;
      continue;
    }
    const type = event.type ?? "unknown";
    eventCounts[type] = (eventCounts[type] ?? 0) + 1;
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      finalMessage = event.item.text ?? "";
    }
    if (event.type === "turn.completed" && event.usage) {
      usage = event.usage;
    }
  }

  return { finalMessage, usage, eventCounts };
}

function compareTargets(targets: readonly TargetRunSummary[]): readonly PairwiseComparison[] {
  const comparisons: PairwiseComparison[] = [];
  for (let leftIndex = 0; leftIndex < targets.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < targets.length; rightIndex += 1) {
      const left = targets[leftIndex];
      const right = targets[rightIndex];
      if (!left || !right) {
        continue;
      }

      comparisons.push({
        left: left.targetId,
        right: right.targetId,
        wordJaccard: wordJaccard(left.finalMessage, right.finalMessage),
        inputTokenDelta: tokenDelta(left.usage?.input_tokens, right.usage?.input_tokens),
        outputTokenDelta: tokenDelta(left.usage?.output_tokens, right.usage?.output_tokens),
        durationMsDelta: left.durationMs - right.durationMs
      });
    }
  }
  return comparisons;
}

function tokenDelta(left: number | undefined, right: number | undefined): number | null {
  return typeof left === "number" && typeof right === "number" ? left - right : null;
}

function wordJaccard(left: string, right: string): number {
  const leftWords = new Set(words(left));
  const rightWords = new Set(words(right));
  if (leftWords.size === 0 && rightWords.size === 0) {
    return 1;
  }

  let intersection = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftWords, ...rightWords]).size;
  return union === 0 ? 0 : Number((intersection / union).toFixed(4));
}

function words(value: string): readonly string[] {
  return value.toLowerCase().match(/[a-z0-9_.-]+/gu) ?? [];
}

function parseFinalJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function runProcess(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...input.env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function mergeCodexConfig(base: CodexConfig, override: CodexConfig): CodexConfig {
  return {
    ...base,
    ...override,
    flags: override.flags ?? base.flags,
    env: {
      ...(base.env ?? {}),
      ...(override.env ?? {})
    },
    envFromProcess: unique([...(base.envFromProcess ?? []), ...(override.envFromProcess ?? [])])
  };
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`Failed to read JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function artifactPaths(targetOutDir: string): TargetRunSummary["artifacts"] {
  return {
    stdoutJsonl: resolve(targetOutDir, "codex-events.jsonl"),
    stderr: resolve(targetOutDir, "stderr.txt"),
    finalMessage: resolve(targetOutDir, "final-message.txt")
  };
}

function resolvePath(path: string): string {
  return resolve(repoRoot, expand(path));
}

function expandPath(path: string): string {
  return resolvePath(path);
}

function expandRecord(record: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expand(value)]));
}

function envFromProcess(keys: readonly string[]): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

function expand(value: string): string {
  return value
    .replaceAll("${REPO_ROOT}", repoRoot)
    .replace(/\$\{([A-Z0-9_]+)\}/gu, (_match, key: string) => {
      const envValue = process.env[key];
      if (envValue === undefined) {
        throw new Error(`Missing environment variable ${key}`);
      }
      return envValue;
    });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redactArgs(
  args: readonly string[],
  env: Readonly<Record<string, string>>
): readonly string[] {
  return args.map((arg) => {
    let redacted = arg;
    for (const [key, value] of Object.entries(env)) {
      if (value.length > 0) {
        redacted = redacted.replaceAll(value, `<redacted:${key}>`);
      }
    }
    return redacted;
  });
}

await main();
