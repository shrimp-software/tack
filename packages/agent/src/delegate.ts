import { renderExecuteGuide, type ExecutionResult, type OperationPolicy } from "@cbxss/tack-codemode";
import type { TackManifest } from "@cbxss/tack-core";

/**
 * `delegate` is code-mode with the code generation moved server-side: an LLM
 * turns a prose goal into ONE complete code-mode program, Tack runs it once in
 * the existing sandbox, and re-plans a couple of times if it throws. No agent
 * loop, no MCP sampling, no suspend/resume — a single non-suspending tool call
 * whose generated program is returned for inspection.
 */

export interface DelegatePlanInput {
  /** The `execute` how-to plus the "write one program" instruction. */
  readonly system: string;
  readonly goal: string;
  /** On a retry, `"<phase>: <message>"` from the previous run. */
  readonly priorError?: string | undefined;
  /** On a retry, the program that failed. */
  readonly priorProgram?: string | undefined;
}

/** Turns a goal (and, on retry, the last failure) into raw model text. */
export type DelegatePlanner = (input: DelegatePlanInput) => Promise<string>;

export interface DelegateOptions {
  readonly planner: DelegatePlanner;
  /** Extra attempts after the first failure. Default 1 (so: plan, run, re-plan, run). */
  readonly replans?: number | undefined;
}

export interface DelegateOutcome {
  readonly status: "completed" | "failed";
  /** The last program that ran. */
  readonly program: string;
  readonly result?: unknown;
  readonly error?: { readonly phase: string; readonly message: string } | undefined;
  readonly attempts: number;
}

const PLAN_INSTRUCTION = [
  "",
  "---",
  "",
  "Generate ONE complete, self-contained program for the `execute` sandbox described above.",
  "It must accomplish the goal end-to-end in a single run: discover the tools it needs inline",
  "(`tools.search`, `tools.describe.tool`), branch on each call's `ok`, handle failures, and",
  "finish with `return <result>`. Reply with exactly one fenced code block and nothing else."
].join("\n");

export function buildDelegateSystemPrompt(
  manifest: TackManifest,
  policy?: OperationPolicy | undefined
): string {
  return `${renderExecuteGuide(manifest, policy)}\n${PLAN_INSTRUCTION}`;
}

/** First fenced code block, else the whole trimmed text. */
export function extractProgram(text: string): string {
  const fenced = text.match(/```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/);
  return (fenced?.[1] ?? text).trim();
}

export async function runDelegate(deps: {
  readonly planner: DelegatePlanner;
  readonly execute: (code: string) => Promise<ExecutionResult>;
  readonly system: string;
  readonly goal: string;
  readonly replans?: number | undefined;
}): Promise<DelegateOutcome> {
  const attempts = Math.max(0, deps.replans ?? 1) + 1;
  let program = "";
  let priorError: string | undefined;
  let priorProgram: string | undefined;
  let last: ExecutionResult | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const planInput: DelegatePlanInput = {
      system: deps.system,
      goal: deps.goal,
      ...(priorError !== undefined ? { priorError } : {}),
      ...(priorProgram !== undefined ? { priorProgram } : {})
    };
    program = extractProgram(await deps.planner(planInput));
    last = await deps.execute(program);
    if (last.ok) {
      return { status: "completed", program, result: last.result, attempts: attempt };
    }
    priorProgram = program;
    priorError = last.error
      ? `${last.error.phase}: ${last.error.message}`
      : "the program returned ok: false";
  }

  return {
    status: "failed",
    program,
    attempts,
    ...(last?.error ? { error: last.error } : {})
  };
}

export interface AnthropicPlannerOptions {
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl?: string | undefined;
  readonly maxTokens?: number | undefined;
}

/** The default planner: one Anthropic Messages API call per attempt. */
export function createAnthropicPlanner(options: AnthropicPlannerOptions): DelegatePlanner {
  const base = options.baseUrl ?? "https://api.anthropic.com";
  const maxTokens = options.maxTokens ?? 4096;

  return async ({ system, goal, priorError, priorProgram }) => {
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: `Goal:\n${goal}` }
    ];
    if (priorProgram !== undefined && priorError !== undefined) {
      messages.push(
        { role: "assistant", content: `\`\`\`ts\n${priorProgram}\n\`\`\`` },
        { role: "user", content: `That program failed with:\n${priorError}\n\nReturn one corrected, complete program.` }
      );
    }

    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": options.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ model: options.model, max_tokens: maxTokens, system, messages })
    });
    if (!response.ok) {
      throw new Error(`Anthropic request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    }
    const body = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = body.content?.find((block) => block.type === "text")?.text;
    if (text === undefined || text === "") {
      throw new Error("Anthropic response contained no text block");
    }
    return text;
  };
}
