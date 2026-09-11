import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findOperation,
  listOperations,
  type Principal,
  type ResponseDescriptor,
  type TackManifest,
  type TackOperation,
  snapshotManifest,
  canonicalJson,
} from "@cbxss/tack-core";
import {
  createResponseStore,
  RESPONSE_JOB_HANDLERS,
  type ResponseStore as Backend,
} from "@cbxss/tack-responses";
import {
  createTrustedValidationPool,
  type TrustedValidationPool,
  type ValidationJob,
  type ValidationResult,
} from "@cbxss/tack-validation";
import { isOperationAllowed, type OperationPolicy } from "./policy.js";
import type { ExecutionResult } from "./types.js";

export const DELIVERY_LIMITS = {
  model: 16 * 1024,
  wire: 32 * 1024,
} as const;
export interface HostOptions {
  readonly root?: string;
}
interface Origin {
  readonly path: string;
  readonly toolId: string;
  readonly sourceRevision?: string;
}
interface Authority {
  readonly manifest: TackManifest;
  readonly policy?: OperationPolicy | undefined;
}
interface Resources {
  root: string;
  workspaceId: string;
  backend: Backend;
  validation: TrustedValidationPool;
}

/** Host-owned storage, authorization and bounded workers, shared across HTTP requests. */
export class ExecutionHost {
  private resources: Promise<Resources> | undefined;
  private readonly authorities = new Map<string, Authority>();
  private closed = false;
  private readonly lineage = new Map<string, Origin[]>();
  private readonly calls = new Map<
    string,
    Array<ResponseDescriptor & { upstreamOutcome: string }>
  >();
  begin(executionId: string): void {
    this.lineage.set(executionId, []);
    this.calls.set(executionId, []);
  }
  canInvoke(
    owner: string,
    operation: TackOperation,
    manifest: TackManifest,
  ): boolean {
    return this.allowed(
      JSON.stringify([operationOrigin(operation, manifest)]),
      { kind: "user", workspaceId: "current", userId: owner },
    );
  }
  private track(
    executionId: string | undefined,
    origins: readonly Origin[],
  ): void {
    if (!executionId) return;
    const current = this.lineage.get(executionId);
    if (current)
      for (const origin of origins)
        if (
          !current.some(
            (item) =>
              item.path === origin.path && item.toolId === origin.toolId,
          )
        )
          current.push(origin);
  }
  constructor(private readonly options: HostOptions = {}) {}
  get durable(): boolean {
    return this.options.root !== undefined;
  }
  authorize(
    owner: string,
    manifest: TackManifest,
    policy?: OperationPolicy,
  ): void {
    this.authorities.set(owner, {
      manifest: snapshotManifest(manifest),
      policy,
    });
  }
  private principal(workspaceId: string, owner: string): Principal {
    return { kind: "user", workspaceId, userId: owner };
  }
  private allowed(origin: string | null, principal: Principal): boolean {
    const authority = this.authorities.get(
      principal.kind === "user" ? principal.userId : "local",
    );
    if (!authority) return false;
    if (!origin) return true;
    try {
      return (JSON.parse(origin) as Origin[]).every((item) => {
        const operation = findOperation(authority.manifest, item.path);
        return (
          operation?.toolId === item.toolId &&
          (!item.sourceRevision ||
            item.sourceRevision ===
              sourceRevision(authority.manifest, operation)) &&
          isOperationAllowed(operation, authority.policy).allowed
        );
      });
    } catch {
      return false;
    }
  }
  private get(): Promise<Resources> {
    if (this.closed) return Promise.reject(new Error("host_closed"));
    return (this.resources ??= this.open());
  }
  private async open(): Promise<Resources> {
    const root = this.options.root
      ? resolve(this.options.root)
      : await mkdtemp(join(tmpdir(), "tack-host-"));
    await mkdir(root, { recursive: true, mode: 0o700 });
    const identity = join(root, "identity.json");
    let workspaceId: string;
    try {
      workspaceId = randomUUID();
      await writeFile(identity, JSON.stringify({ workspaceId }), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      workspaceId = (
        JSON.parse(await readFile(identity, "utf8")) as { workspaceId: string }
      ).workspaceId;
    }
    if (!/^[0-9a-f-]{36}$/u.test(workspaceId))
      throw new Error("invalid_state_identity");
    const validation = await createTrustedValidationPool({
      root,
      handlers: RESPONSE_JOB_HANDLERS,
    });
    try {
      const backend = await createResponseStore({
        root,
        workspaceId,
        jobs: validation.pool,
        policy: {
          authorizeOrigin: (origin, principal) =>
            this.allowed(origin, principal),
        },
      });
      return { root, workspaceId, backend, validation };
    } catch (error) {
      await validation.close();
      throw error;
    }
  }
  async validate(
    owner: string,
    job: ValidationJob,
    signal?: AbortSignal,
  ): Promise<ValidationResult> {
    const state = await this.get();
    return state.validation.runner.run(job, {
      ownerKey: state.backend.ownerKey(
        this.principal(state.workspaceId, owner),
      ),
      ...(signal ? { signal } : {}),
    });
  }
  async retain(
    owner: string,
    data: unknown,
    options: {
      origins?: readonly Origin[];
      executionId?: string | undefined;
      raw?: unknown;
      text?: string;
      evidence?: unknown;
      upstreamOutcome?: "succeeded" | "failed" | "unknown" | "not_started";
    } = {},
  ): Promise<ResponseDescriptor> {
    const state = await this.get();
    this.track(options.executionId, options.origins ?? []);
    const descriptor = await state.backend.retain(
      this.principal(state.workspaceId, owner),
      {
        formatVersion: 1,
        kind: options.raw === undefined ? "derived-result" : "tool-response",
        data: data ?? null,
        text: options.text ?? "",
        ...(options.raw === undefined ? {} : { raw: options.raw }),
        ...(options.evidence === undefined
          ? {}
          : { provenance: JSON.parse(JSON.stringify(options.evidence)) }),
        ...(options.upstreamOutcome
          ? { upstreamOutcome: options.upstreamOutcome }
          : {}),
      },
      {
        operationId: JSON.stringify(options.origins ?? []),
        ...(options.executionId ? { executionId: options.executionId } : {}),
        ...(options.upstreamOutcome
          ? { upstreamOutcome: options.upstreamOutcome }
          : {}),
      },
    );
    if (options.executionId)
      this.calls
        .get(options.executionId)
        ?.push({
          ...descriptor,
          upstreamOutcome: options.upstreamOutcome ?? "unknown",
        });
    return descriptor;
  }
  async finish(
    owner: string,
    code: string,
    result: ExecutionResult,
    manifest: TackManifest,
  ): Promise<ExecutionResult> {
    const origins = this.lineage.get(result.executionId ?? "") ?? [];
    this.lineage.delete(result.executionId ?? "");
    const responses = this.calls.get(result.executionId ?? "") ?? [];
    this.calls.delete(result.executionId ?? "");
    let response: ResponseDescriptor;
    try {
      response = await this.retain(owner, result.result ?? null, {
        origins,
        executionId: result.executionId,
        evidence: {
          code,
          responses,
          logs: result.logs,
          emitted: result.emitted,
          diagnostics: result.typeDiagnostics ?? [],
          trace: result.trace ?? null,
          error: result.error ?? null,
        },
      });
    } catch (error) {
      return {
        ok: false,
        executionId: result.executionId,
        logs: [],
        emitted: [],
        error: {
          phase: "runtime",
          code: "internal_error",
          message: `Final response persistence failed; earlier calls may have succeeded. Do not replay automatically. ${error instanceof Error ? error.message.slice(0, 500) : "Storage error"}`,
        },
        result: {
          upstreamResponseCount: responses.length,
          upstreamResponses: responses
            .slice(0, 8)
            .map((response) => ({
              id: response.id,
              upstreamOutcome: response.upstreamOutcome,
            })),
        },
      };
    }
    if (
      !this.allowed(JSON.stringify(origins), {
        kind: "user",
        workspaceId: "current",
        userId: owner,
      })
    ) {
      return {
        ok: false,
        executionId: result.executionId,
        logs: [],
        emitted: [],
        error: {
          phase: "runtime",
          code: "operation_denied",
          message:
            "Origin authorization changed before delivery; saved evidence remains subject to current policy.",
        },
      };
    }
    const base: ExecutionResult = {
      ...result,
      ...(result.typeDiagnostics
        ? { typeDiagnostics: compactDiagnostics(result.typeDiagnostics) }
        : {}),
      ...(result.error
        ? {
            error: {
              ...result.error,
              message:
                result.error.phase === "typecheck" &&
                result.typeDiagnostics?.length
                  ? "Strict typechecking failed. Full diagnostics are retained with this receipt."
                  : result.error.message.slice(0, 1000),
            },
          }
        : {}),
      receiptId: response.id,
      responseId: response.id,
    };
    if (
      jsonBytes(publicExecution(base)) <= DELIVERY_LIMITS.model &&
      jsonBytes(mcpWire(publicExecution(base))) <= DELIVERY_LIMITS.wire
    )
      return base;
    // Over budget: clip the return value and drop the bulky side channels. No
    // retrieval path — the full value stays only in the retained receipt for
    // audit. An array keeps whole leading elements (so its shape survives and
    // the model can still compute from a sample); anything else falls back to a
    // readable string head. Halve the budget until the projected result and its
    // MCP wire copy fit, since re-serializing re-escapes by a content-dependent
    // amount.
    let clipBudget = Math.max(512, DELIVERY_LIMITS.model - 4096);
    let truncated: ExecutionResult;
    do {
      truncated = {
        ok: result.ok,
        executionId: result.executionId,
        receiptId: response.id,
        responseId: response.id,
        result: clipForModel(result.result ?? null, clipBudget),
        resultTruncated: true,
        logs: [],
        emitted: [],
        ...(base.error ? { error: base.error } : {}),
        ...(base.typeDiagnostics ? { typeDiagnostics: base.typeDiagnostics } : {}),
      };
      clipBudget = Math.floor(clipBudget / 2);
    } while (
      clipBudget > 128 &&
      (jsonBytes(publicExecution(truncated)) > DELIVERY_LIMITS.model ||
        jsonBytes(mcpWire(publicExecution(truncated))) > DELIVERY_LIMITS.wire)
    );
    return truncated;
  }
  async close(): Promise<void> {
    this.closed = true;
    if (!this.resources) return;
    const state = await this.resources;
    await state.backend.close();
    await state.validation.close();
    if (!this.options.root)
      await rm(state.root, { recursive: true, force: true });
  }
}
export function operationOrigin(
  operation: TackOperation,
  manifest?: TackManifest,
): Origin {
  return {
    path: operation.fullPathString,
    toolId: operation.toolId,
    ...(manifest
      ? { sourceRevision: sourceRevision(manifest, operation) }
      : {}),
  };
}
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null");
}
export function mcpWire(value: unknown): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  };
}
const revisions = new WeakMap<TackManifest, string>();
export function catalogRevision(manifest: TackManifest): string {
  let revision = revisions.get(manifest);
  if (!revision) {
    revision = createHash("sha256")
      .update(
        canonicalJson({
          operations: listOperations(manifest),
          servers: manifest.servers,
        }),
      )
      .digest("hex");
    if (Object.isFrozen(manifest)) revisions.set(manifest, revision);
  }
  return revision;
}
function sourceRevision(
  manifest: TackManifest,
  operation: TackOperation,
): string {
  return createHash("sha256")
    .update(canonicalJson(manifest.servers[operation.serverId] ?? null))
    .digest("hex");
}

function compactDiagnostics(
  items: readonly import("./types.js").TypeDiagnostic[],
) {
  const seen = new Set<string>();
  const out = [];
  for (const item of items) {
    const key = `${item.code}:${item.message}`;
    if (seen.has(key)) continue;
    const next = { ...item, message: item.message.slice(0, 300) };
    if (out.length === 3 || jsonBytes([...out, next]) > 2048) break;
    seen.add(key);
    out.push(next);
  }
  return out;
}

/** Shared projection keeps host admission and the MCP wire formatter identical. */
export function publicExecution(
  result: ExecutionResult,
): Record<string, unknown> {
  return {
    status: result.ok ? "completed" : "error",
    result: result.result ?? null,
    ...(result.resultTruncated ? { resultTruncated: true } : {}),
    ...(result.receiptId ? { receiptId: result.receiptId } : {}),
    ...(result.responseId ? { responseId: result.responseId } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.typeDiagnostics?.length
      ? { typeDiagnostics: result.typeDiagnostics }
      : {}),
    ...(result.emitted.length ? { emitted: result.emitted } : {}),
    ...(result.logs.length ? { logs: result.logs } : {}),
  };
}

/**
 * Clip an over-budget cell return value so its shape survives. An array keeps its
 * leading whole elements; an object keeps its leading keys' whole values; a
 * scalar (or a value nothing else fits) falls back to a readable string head.
 * The full value stays only in the retained receipt.
 */
function clipForModel(value: unknown, budget: number): unknown {
  const fits = (framed: unknown): boolean => {
    const text = safeStringify(framed);
    return text !== undefined && Buffer.byteLength(text, "utf8") <= budget;
  };

  if (Array.isArray(value) && value.length > 0) {
    // Binary-search the element count that fits.
    let lo = 0;
    let hi = Math.min(value.length, 500);
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fits({ truncated: true, shown: mid, total: value.length, items: value.slice(0, mid) })) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best >= 0) {
      return { truncated: true, shown: best, total: value.length, items: value.slice(0, best) };
    }
  } else if (value !== null && typeof value === "object") {
    // Keep whole values for as many leading keys as fit; name the rest.
    // Size each value once and accumulate — O(n), not O(n²) re-serialization.
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const kept: Record<string, unknown> = {};
    let shownKeys = 0;
    let used = 40; // framing overhead for {truncated,shownKeys,totalKeys,kept:{},omitted:[]}
    for (const key of keys) {
      const piece = safeStringify(record[key]);
      const cost = (piece === undefined ? 4 : Buffer.byteLength(piece, "utf8")) + key.length + 12;
      if (used + cost > budget) break;
      kept[key] = record[key];
      used += cost;
      shownKeys += 1;
    }
    if (shownKeys > 0) {
      return {
        truncated: true,
        shownKeys,
        totalKeys: keys.length,
        kept,
        omitted: keys.slice(shownKeys),
      };
    }
    // A single leading value blows the budget on its own: recurse into it so
    // its shape still survives, rather than stringifying the whole object.
    if (keys.length > 0) {
      return {
        truncated: true,
        key: keys[0],
        totalKeys: keys.length,
        omitted: keys.slice(1),
        value: clipForModel(record[keys[0]!], Math.max(256, budget - keys[0]!.length - 64)),
      };
    }
  }
  return clipToStringHead(value, budget);
}

/** A readable, byte-accurate string head with a `[truncated N bytes]` marker. */
function clipToStringHead(value: unknown, budget: number): string {
  const text = safeStringify(value) ?? String(value);
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= budget) return text;
  let head = buf.subarray(0, Math.max(1, budget)).toString("utf8");
  if (head.endsWith("�")) head = head.slice(0, -1);
  return `${head}…[truncated ${buf.length - Buffer.byteLength(head)} bytes]`;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value) ?? undefined;
  } catch {
    return undefined;
  }
}
