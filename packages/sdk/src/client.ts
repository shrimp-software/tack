import { dirname, resolve } from "node:path";
import {
  DEFAULT_CONFIG_PATH, listOperations, loadConfigPromise, ownField, parseConfig,
  resolveConfigPaths, sanitizeData, snapshotManifest,
  type TackConfig, type TackManifest, type TackRuntime, type UpstreamOutcome
} from "@cbxss/tack-core";
import {
  CodeRuntimeTimeoutError, createAuditSink, createOperationPolicy, createTackToolInvoker, describeTool,
  isOperationAllowed, searchOperations, withAbort,
  type OperationPolicy, type ToolCallOutput, type ToolInvoker
} from "@cbxss/tack-codemode";
import { resolvePluginsIntoConfig } from "@cbxss/tack-plugin";
import { createRuntime, discoverManifest, SOURCE_KINDS } from "@cbxss/tack-sources";
import { invocationError, responseOrThrow, TackError } from "./errors.js";
import { createTools } from "./tools.js";
import type {
  TackArgs, TackCallOptions, TackDescription, TackOptions,
  TackResponse, TackSearchInput, TackSearchResult
} from "./types.js";

/** Selectors must be own data properties: skipping a getter/inherited selector
 * would silently change the config being selected. Never invoke accessors. */
function readConfigSelectors(options: unknown): { config?: unknown; configPath?: unknown; configDir?: unknown } {
  if (options === undefined) return {};
  try {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new Error("Tack options must be an object");
    }
    const selectors: { config?: unknown; configPath?: unknown; configDir?: unknown } = {};
    for (const key of ["config", "configPath", "configDir"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (descriptor) {
        if (!("value" in descriptor)) throw new Error(`${key} must be an own data property, not an accessor`);
        selectors[key] = descriptor.value;
      } else if (key in options) {
        throw new Error(`${key} must be an own data property, not inherited`);
      }
    }
    return selectors;
  } catch (cause) {
    throw new TackError("Invalid Tack configuration selectors", { code: "invalid_options", cause });
  }
}

interface Initialized {
  readonly manifest: TackManifest;
  readonly invoker: ToolInvoker;
  readonly policy: OperationPolicy | undefined;
}

/** Internal implementation: instance compatibility depends on tools, not options.
 * The public constructor in index.ts binds these tools to runtime config options. */
export class Tack<Tools> {
  readonly tools: Tools;
  #configPath: string | undefined;
  #inlineConfig: unknown;
  #configDir: string;
  #cwd: string;
  #initialization: Promise<Initialized> | undefined;
  #runtime: TackRuntime | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #calls = new Map<AbortController, Promise<unknown>>();

  constructor(options?: TackOptions) {
    this.#cwd = process.cwd();
    const { config, configPath, configDir } = readConfigSelectors(options);
    if ((config !== undefined && configPath !== undefined)
      || (config === undefined && configDir !== undefined)
      || (configPath !== undefined && (typeof configPath !== "string" || !configPath))
      || (configDir !== undefined && (typeof configDir !== "string" || !configDir))) {
      throw new TackError("Use configPath or inline config with configDir, not both", { code: "invalid_options" });
    }
    this.#configPath = config === undefined ? resolve(this.#cwd, configPath as string ?? DEFAULT_CONFIG_PATH) : undefined;
    this.#configDir = this.#configPath ? dirname(this.#configPath) : resolve(this.#cwd, configDir as string ?? ".");
    try {
      this.#inlineConfig = sanitizeData(config, { onCycle: "Cyclic Tack config data is not supported" });
    } catch (cause) {
      throw new TackError("Invalid inline Tack config", { code: "invalid_options", cause });
    }
    this.tools = createTools((path, args, callOptions) => this.call(path, args, callOptions)) as Tools;
  }

  async ready(): Promise<void> {
    await this.#ensureInitialized();
    this.#assertOpen();
  }

  call(path: string, args: TackArgs = {}, options: TackCallOptions = {}): Promise<TackResponse> {
    let snapshot: unknown;
    try { snapshot = sanitizeData(args, { onCycle: "Cyclic tool arguments are not supported" }); }
    catch (cause) { return Promise.reject(new TackError("Invalid tool arguments", { code: "input_validation_failed", path, cause })); }
    return this.#run(path, options, async (signal, timeoutMs) => {
      const state = await this.#waitForInitialization(signal, path);
      try {
        const output = await state.invoker.invoke({ path, args: snapshot, signal, timeoutMs: timeoutMs === undefined ? undefined : null });
        return responseOrThrow(output as ToolCallOutput, path);
      } catch (cause) { throw invocationError(cause, path); }
    });
  }

  search(input: TackSearchInput = { query: "" }, options: TackCallOptions = {}): Promise<TackSearchResult> {
    let snapshot: TackSearchInput;
    try { snapshot = sanitizeData(input, {}) as TackSearchInput; }
    catch (cause) { return Promise.reject(new TackError("Invalid search input", { code: "invalid_options", cause })); }
    return this.#run(undefined, options, async signal => {
      const state = await this.#waitForInitialization(signal);
      // Discovery metadata shares the invoker's cached operation graph; never expose it.
      return sanitizeData(searchOperations(state.manifest, snapshot, state.policy), {}) as TackSearchResult;
    });
  }

  describe(path: string, options: TackCallOptions = {}): Promise<TackDescription> {
    return this.#run(path, options, async signal => {
      const state = await this.#waitForInitialization(signal, path);
      const operation = listOperations(state.manifest).find(operation => operation.fullPathString === path);
      if (!operation) throw new TackError(`Unknown Tack operation: ${path}`, { code: "unknown_operation", path });
      const decision = isOperationAllowed(operation, state.policy);
      if (!decision.allowed) throw new TackError(decision.reason ?? `Operation denied: ${path}`, { code: "operation_denied", path });
      const result = await withAbort(describeTool(state.manifest, { path }, state.policy), signal);
      if ("error" in result) throw new TackError(result.error.message, { code: "unknown_operation", path });
      return sanitizeData(result, {}) as TackDescription;
    });
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    for (const controller of this.#calls.keys()) controller.abort(new Error("Tack client is closed"));
    this.#closing = (async () => {
      // Initialization owns temporary discovery connections; never abandon it.
      await this.#initialization?.catch(() => undefined);
      try {
        await this.#runtime?.close();
      } catch (cause) {
        throw new TackError("Failed to close Tack transports", { code: "internal_error", cause });
      } finally {
        await Promise.allSettled([...this.#calls.values()]);
      }
    })();
    return this.#closing;
  }

  [Symbol.asyncDispose](): Promise<void> { return this.close(); }

  #assertOpen(path?: string): void {
    if (this.#closed) throw new TackError("Tack client is closed", { code: "client_closed", path });
  }

  #ensureInitialized(): Promise<Initialized> {
    this.#assertOpen();
    return this.#initialization ??= this.#initialize();
  }

  async #initialize(): Promise<Initialized> {
    try {
      const loaded = this.#configPath
        ? await loadConfigPromise(this.#configPath, SOURCE_KINDS)
        : resolveConfigPaths(parseConfig(this.#inlineConfig, SOURCE_KINDS), this.#configDir, SOURCE_KINDS);
      this.#assertOpen();
      const config = await resolvePluginsIntoConfig(loaded, { configDir: this.#configDir });
      this.#assertOpen();
      const manifest = snapshotManifest(await discoverManifest(config, { configDir: this.#configDir }));
      this.#assertOpen();
      this.#runtime = await createRuntime({ config, manifest, configDir: this.#configDir });
      this.#assertOpen();
      const policy = createOperationPolicy(config);
      // Audit paths historically use cwd, unlike source paths. Anchor that cwd
      // at construction so later chdir cannot redirect configured evidence.
      const auditPath = config.security?.auditLog?.path;
      const auditConfig: TackConfig = auditPath ? {
        ...config, security: { ...config.security, auditLog: { path: resolve(this.#cwd, auditPath) } }
      } : config;
      const invoker = createTackToolInvoker({
        manifest, runtime: this.#runtime, policy, canonicalOperationsOnly: true,
        toolTimeoutMs: config.runtime?.toolTimeoutMs,
        normalizeWhitespace: config.runtime?.normalizeWhitespace,
        onAuditEvent: createAuditSink(auditConfig)
      });
      return { manifest, invoker, policy };
    } catch (cause) {
      // Keep a stable initialization failure; cleanup must not replace its cause.
      await this.#runtime?.close().catch(() => undefined);
      this.#runtime = undefined;
      if (cause instanceof TackError) throw cause;
      throw new TackError("Failed to initialize Tack", { code: "initialization_failed", cause });
    }
  }

  async #waitForInitialization(signal: AbortSignal, path?: string): Promise<Initialized> {
    if (signal.aborted) throw this.#cancelled(signal, path);
    // A caller may stop waiting, but cannot cancel another caller's discovery.
    let state: Initialized;
    try {
      state = await withAbort(this.#ensureInitialized(), signal);
    } catch (cause) {
      if (cause instanceof TackError && path !== undefined && cause.path === undefined) {
        throw new TackError(cause.message, { code: cause.code, path, upstreamOutcome: cause.upstreamOutcome, cause });
      }
      throw cause;
    }
    this.#assertOpen(path);
    signal.throwIfAborted();
    return state;
  }

  #cancelled(signal: AbortSignal, path?: string): TackError {
    return new TackError("Tack call cancelled", { code: "cancelled", path, cause: signal.reason });
  }

  #run<T>(path: string | undefined, options: TackCallOptions, run: (signal: AbortSignal, timeoutMs: number | undefined) => Promise<T>): Promise<T> {
    try {
      this.#assertOpen(path);
      const timeoutMs = ownField<number>(options, "timeoutMs");
      if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) {
        throw new TackError("timeoutMs must be an integer between 1 and 2147483647", { code: "invalid_options", path });
      }
      const external = ownField<AbortSignal>(options, "signal");
      if (external !== undefined && !(external instanceof AbortSignal)) {
        throw new TackError("signal must be an AbortSignal", { code: "invalid_options", path });
      }
      const controller = new AbortController();
      const abort = () => controller.abort(external?.reason);
      if (external?.aborted) abort();
      else external?.addEventListener("abort", abort, { once: true });
      // One caller deadline spans discovery waiting and downstream work. Shared
      // initialization itself is never aborted by this controller.
      let timedOut = false;
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        if (controller.signal.aborted) return;
        timedOut = true;
        controller.abort(new CodeRuntimeTimeoutError(`Tack request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Defer work until registered so close() sees even synchronous call starts.
      const pending = Promise.resolve().then(() => run(controller.signal, timeoutMs)).then(value => {
        if (controller.signal.aborted) throw new TackError("Tack call cancelled", {
          code: "cancelled", path, cause: controller.signal.reason,
          upstreamOutcome: ownField<UpstreamOutcome>(value, "upstreamOutcome") ?? "not_started"
        });
        return value;
      }).catch((cause: unknown) => {
        if (timedOut) throw new TackError(`Tack request timed out after ${timeoutMs}ms`, {
          code: "tool_timeout", path, cause,
          upstreamOutcome: cause instanceof TackError ? cause.upstreamOutcome : "not_started"
        });
        if (cause instanceof TackError) throw cause;
        if (controller.signal.aborted) throw this.#cancelled(controller.signal, path);
        throw new TackError(cause instanceof Error ? cause.message : "Tack request failed", { code: "internal_error", path, cause });
      }).finally(() => {
        clearTimeout(timer);
        external?.removeEventListener("abort", abort);
        this.#calls.delete(controller);
      });
      this.#calls.set(controller, pending);
      return pending;
    } catch (cause) { return Promise.reject(cause); }
  }
}
