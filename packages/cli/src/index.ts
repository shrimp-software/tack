#!/usr/bin/env node
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import {
  createAnthropicPlanner,
  listenTackMcpHttp,
  serveTackMcpStdio,
  type DelegateOptions
} from "@cbxss/tack-agent";
import {
  createExecutionEngine,
  formatTraceLine,
  formatTypeDiagnostics,
  isOperationAllowed,
  type CreateExecutionEngineOptions,
  type ExecutionResult,
  type OperationPolicy,
  type ToolAuditEvent
} from "@cbxss/tack-codemode";
import { createTypeChecker } from "@cbxss/tack-typecheck";
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_OUTPUT_DIR,
  createDefaultConfig,
  findOperation,
  listOperations,
  loadConfigPromise,
  operationArgs,
  type PluginRef,
  type TackConfig,
  type TackManifest,
  type TackOperation,
  writeJsonPromise
} from "@cbxss/tack-core";
import { generateDocsPromise, generateSdkPromise } from "@cbxss/tack-generator";
import {
  ensureCheckout,
  parsePluginRef,
  readLock,
  readPluginLayout,
  resolveCommit,
  resolvePluginsIntoConfig,
  withLockEntry,
  withoutLockEntry,
  writeLock,
  type ParsedPluginRef
} from "@cbxss/tack-plugin";
import { createRuntime, discoverManifest } from "@cbxss/tack-sources";
import { createQuickJSRuntime } from "@cbxss/tack-runtime-quickjs";
import { createWorkerdRuntime } from "@cbxss/tack-runtime-workerd";
import { listenTackHttpService } from "@cbxss/tack-service";
import { formatCliError } from "./cli-output.js";
import { runDoctor } from "./doctor.js";
import {
  defaultSkillOutputDirectory,
  installTackSkill,
  tackSkillFiles,
  tackSkillMarkdown
} from "./skill.js";

const program = new Command();
const DEFAULT_DISCOVERY_CACHE_PATH = ".tack/discovery-cache.json";

program
  .name("tack")
  .description("Compile MCP tools into agent-friendly SDKs and code-mode tools")
  .version("0.1.0");

program
  .command("init")
  .description("Create a minimal tack.config.json")
  .option("-c, --config <path>", "config path", DEFAULT_CONFIG_PATH)
  .action(async (options: { config: string }) =>
    run(async () => {
      if (await exists(options.config)) {
        console.log(`${options.config} already exists`);
        return;
      }

      await writeJsonPromise(options.config, createDefaultConfig());
      console.log(`Wrote ${options.config}`);
    })
  );

program
  .command("generate")
  .description("Generate a static SDK from live MCP discovery")
  .option("-c, --config <path>", "config path", DEFAULT_CONFIG_PATH)
  .option("-o, --out <dir>", "SDK output directory")
  .action(async (options: { config: string; out?: string }) =>
    run(async () => {
      const { config, manifest } = await loadWorkspace(options.config);
      const outDir = options.out ?? config.output?.dir ?? DEFAULT_OUTPUT_DIR;
      await generateSdkPromise({ manifest, outDir });
      console.log(`Generated TypeScript SDK in ${outDir}`);
    })
  );

program
  .command("docs")
  .description("Generate markdown docs from live MCP discovery")
  .option("-c, --config <path>", "config path", DEFAULT_CONFIG_PATH)
  .option("-o, --out <path>", "docs output path", ".tack/tools.md")
  .option("--title <title>", "docs title")
  .action(async (options: { config: string; out: string; title?: string }) =>
    run(async () => {
      const { manifest } = await loadWorkspace(options.config);
      await generateDocsPromise({
        manifest,
        outFile: options.out,
        ...(options.title ? { title: options.title } : {})
      });
      console.log(`Generated docs at ${options.out}`);
    })
  );

program
  .command("build")
  .description("Run live discovery, refresh the cache, and generate an SDK")
  .option("-c, --config <path>", "config path", DEFAULT_CONFIG_PATH)
  .option("-o, --out <dir>", "SDK output directory")
  .action(async (options: { config: string; out?: string }) =>
    run(async () => {
      const { config, manifest } = await loadWorkspace(options.config);
      await writeJsonPromise(DEFAULT_DISCOVERY_CACHE_PATH, manifest);
      const outDir = options.out ?? config.output?.dir ?? DEFAULT_OUTPUT_DIR;
      await generateSdkPromise({ manifest, outDir });
      console.log(`Built ${toolCount(manifest)} tools into TypeScript SDK at ${outDir}`);
    })
  );

program
  .command("inspect")
  .description("Print discovered servers and inferred operations")
  .option("-c, --config <path>", "config path", DEFAULT_CONFIG_PATH)
  .action(async (options: { config: string }) =>
    run(async () => {
      const { manifest } = await loadWorkspace(options.config);
      const operationsByServer = groupOperationsByServer(listOperations(manifest));
      for (const server of Object.values(manifest.servers)) {
        console.log(`${server.id} (${server.transport})`);
        for (const operation of operationsByServer.get(server.id) ?? []) {
          const injected = operation.injectedArgs
            ? ` ${JSON.stringify(operation.injectedArgs)}`
            : "";
          console.log(`  ${operation.fullPathString} -> ${operation.toolId}${injected}`);
        }
      }
    })
  );

program
  .command("doctor")
  .description("Validate the Tack CLI environment, config, and MCP discovery")
  .option("-c, --config <path>", "config path", DEFAULT_CONFIG_PATH)
  .option("--no-discovery", "skip live MCP discovery")
  .action(async (options: { config: string; discovery: boolean }) =>
    run(async () => {
      const report = await runDoctor({
        config: options.config,
        discovery: options.discovery
      });
      for (const line of report.lines) {
        console.log(line);
      }
      if (!report.ok) {
        process.exitCode = 1;
      }
    })
  );

program
  .command("call")
  .description("Invoke an inferred operation path or canonical Tack tool ID")
  .argument("<path>")
  .requiredOption("--json <args>", "JSON object arguments")
  .option("-c, --config <path>", "config path", DEFAULT_CONFIG_PATH)
  .action(
    async (
      path: string,
      options: { json: string; config: string }
    ) =>
      run(async () => {
        const { config, manifest } = await loadWorkspace(options.config);
        const args = parseJsonArgs(options.json);
        const policy = createOperationPolicy(config);
        const onAuditEvent = createAuditSink(config);
        const target = resolveCallTarget(manifest, path, Boolean(policy));
        const runtime = await createRuntime({ config, manifest });
        const started = Date.now();

        try {
          if (target.operation) {
            const decision = isOperationAllowed(target.operation, policy);
            if (!decision.allowed) {
              await emitCliCallAudit(onAuditEvent, {
                type: "tool_call",
                timestamp: new Date().toISOString(),
                path: target.operation.fullPathString,
                toolId: target.operation.toolId,
                allowed: false,
                ok: false,
                durationMs: Date.now() - started,
                error: decision.reason
              });
              throw new Error(decision.reason ?? `Operation denied by policy: ${target.operation.fullPathString}`);
            }
          }

          const result = await runtime.invoke(target.toolId, target.operation
            ? operationArgs(target.operation, args)
            : args);
          await emitCliCallAudit(onAuditEvent, {
            type: "tool_call",
            timestamp: new Date().toISOString(),
            path: target.operation?.fullPathString ?? path,
            toolId: target.toolId,
            allowed: true,
            ok: !result.isError,
            durationMs: Date.now() - started,
            ...(result.isError ? { error: result.text() } : {})
          });
          console.log(JSON.stringify(result.raw, null, 2));
        } finally {
          await runtime.close();
        }
    })
  );

program
  .command("execute")
  .description("Execute TypeScript against discovered MCP tools")
  .argument("[code]")
  .option("-f, --file <path>", "read code from a file")
  .option("-c, --config <path>", "config path", DEFAULT_CONFIG_PATH)
  .option("--timeout-ms <ms>", "execution timeout override")
  .option("--json", "print the complete execution envelope")
  .option("--quiet", "do not stream the live tool-call trace to stderr")
  .action(async (
    code: string | undefined,
    options: { file?: string; config: string; timeoutMs?: string; json?: boolean; quiet?: boolean }
  ) =>
    run(async () => {
      const source = await resolveExecutionSource(code, options.file);
      const { config, manifest } = await loadWorkspace(options.config);
      const timeoutMs = options.timeoutMs ? parsePositiveInt(options.timeoutMs, "timeout-ms") : undefined;
      const runtimeConfig: TackConfig = timeoutMs
        ? {
          ...config,
          runtime: {
            ...config.runtime,
            timeoutMs
          }
        }
        : config;
      const runtime = await createRuntime({ config, manifest });
      const policy = createOperationPolicy(config);
      const onAuditEvent = createAuditSink(config);
      const typecheck = createTypecheckOptions(config, manifest, policy);
      const engine = createExecutionEngine({
        manifest,
        runtime,
        codeRuntime: createCodeRuntime(runtimeConfig),
        ...(policy ? { policy } : {}),
        ...(onAuditEvent ? { onAuditEvent } : {}),
        ...(typecheck ? { typecheck } : {}),
        ...(options.quiet ? {} : { onTrace: (event) => console.error(formatTraceLine(event)) })
      });

      try {
        const result = await engine.execute(source);
        printExecutionResult(result, Boolean(options.json));
        if (!result.ok) {
          process.exitCode = 1;
        }
      } finally {
        await runtime.close();
      }
    })
  );

const skill = program
  .command("skill")
  .description("Print or install the Codex skill for Tack");

skill
  .command("print")
  .description("Print the Tack Codex skill SKILL.md")
  .action(() => {
    console.log(tackSkillMarkdown());
  });

skill
  .command("install")
  .description("Install the Tack Codex skill into a skills directory")
  .option("-o, --out <dir>", "skills output directory")
  .option("--force", "overwrite an existing Tack skill")
  .action(async (options: { out?: string; force: boolean }) =>
    run(async () => {
      const outDir = options.out ?? defaultSkillOutputDirectory();
      const skillDir = await installTackSkill(outDir, { force: options.force });
      console.log(`Installed Tack skill at ${skillDir}`);
      console.log(`Wrote ${tackSkillFiles().map((file) => file.path).join(", ")}`);
    })
  );

const plugins = program
  .command("plugins")
  .description("Add, list, update, or remove plugin bundles");

type GitPluginRef = Extract<PluginRef, { source: string }>;

/** Fetch a git plugin into the cache. Returns the plugin root + resolved commit. */
async function fetchGitPlugin(
  configDir: string,
  ref: GitPluginRef,
  name: string
): Promise<{ commit: string; root: string; parsed: Extract<ParsedPluginRef, { kind: "git" }> }> {
  const parsed = parsePluginRef(ref, name);
  if (parsed.kind !== "git") {
    throw new Error(`Plugin "${name}" is not a git source`);
  }
  const commit = await resolveCommit(parsed);
  const root = await ensureCheckout({ ref: parsed, commit, cacheRoot: join(configDir, ".tack", "plugins") });
  return { commit, root, parsed };
}

async function writeGitLock(
  configDir: string,
  name: string,
  parsed: Extract<ParsedPluginRef, { kind: "git" }>,
  commit: string
): Promise<void> {
  const lockPath = join(configDir, "tack.plugins.lock");
  await writeLock(lockPath, withLockEntry(await readLock(lockPath), name, {
    source: parsed.source,
    ref: parsed.ref,
    ...(parsed.subdir ? { subdir: parsed.subdir } : {}),
    resolvedCommit: commit
  }));
}

/** Read/mutate/write the `plugins` block of tack.config.json. */
async function updatePluginsBlock(
  configPath: string,
  mutate: (block: Record<string, unknown>) => void
): Promise<void> {
  const raw = await readConfigObject(configPath);
  const block: Record<string, unknown> = { ...(raw["plugins"] as Record<string, unknown> | undefined) };
  mutate(block);
  if (Object.keys(block).length > 0) {
    raw["plugins"] = block;
  } else {
    delete raw["plugins"];
  }
  await writeJsonPromise(configPath, raw);
}

plugins
  .command("add")
  .description("Fetch a plugin and add it to tack.config.json")
  .argument("<ref>", 'plugin source: "github:owner/repo", an https/ssh git URL, or a local path')
  .option("-c, --config <path>", "config path", DEFAULT_CONFIG_PATH)
  .option("--ref <ref>", "git tag, branch, or commit (required for a git source)")
  .option("--subdir <dir>", "plugin root within the repo")
  .option("--as <name>", "namespace to mount the plugin under")
  .action(async (
    ref: string,
    options: { config: string; ref?: string; subdir?: string; as?: string }
  ) =>
    run(async () => {
      const configDir = dirname(resolve(options.config));
      const isLocal = ref.startsWith(".") || ref.startsWith("/");
      if (!isLocal && !options.ref) {
        throw new Error("A git plugin source needs --ref <tag|branch|commit>");
      }

      let root: string;
      let fetched: Awaited<ReturnType<typeof fetchGitPlugin>> | null = null;
      const pluginRef = isLocal
        ? { path: ref }
        : { source: ref, ref: options.ref!, ...(options.subdir ? { subdir: options.subdir } : {}) };
      if ("path" in pluginRef) {
        root = resolve(configDir, pluginRef.path);
      } else {
        fetched = await fetchGitPlugin(configDir, pluginRef, options.as ?? "plugin");
        root = fetched.root;
      }

      const layout = await readPluginLayout(root);
      const name = options.as ?? layout.manifest.name;
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
        throw new Error(`Plugin name "${name}" is not a valid namespace; pass --as <name>`);
      }

      if (fetched) {
        await writeGitLock(configDir, name, fetched.parsed, fetched.commit);
      }
      await updatePluginsBlock(options.config, (block) => { block[name] = pluginRef; });
      console.log(
        `Added plugin ${name}: ${layout.skills.length} skill(s), ${layout.mcpServers.length} bundled MCP server(s)`
      );
    })
  );

plugins
  .command("list")
  .description("List configured plugins")
  .option("-c, --config <path>", "config path", DEFAULT_CONFIG_PATH)
  .action(async (options: { config: string }) =>
    run(async () => {
      const configDir = dirname(resolve(options.config));
      const config = await loadConfigPromise(options.config);
      const entries = Object.entries(config.plugins ?? {});
      if (entries.length === 0) {
        console.log("No plugins configured.");
        return;
      }
      const lock = await readLock(join(configDir, "tack.plugins.lock"));
      for (const [name, ref] of entries) {
        const where = "path" in ref ? ref.path : `${ref.source}@${ref.ref}`;
        const commit = lock.plugins[name]?.resolvedCommit;
        console.log(`${name}  ${where}${commit ? `  (${commit.slice(0, 12)})` : ""}`);
      }
    })
  );

plugins
  .command("update")
  .description("Re-resolve and re-fetch git plugins")
  .argument("[name]", "plugin to update (default: all git plugins)")
  .option("-c, --config <path>", "config path", DEFAULT_CONFIG_PATH)
  .option("--ref <ref>", "new git ref (only with a <name>)")
  .action(async (name: string | undefined, options: { config: string; ref?: string }) =>
    run(async () => {
      const configDir = dirname(resolve(options.config));
      const config = await loadConfigPromise(options.config);
      const targets = Object.entries(config.plugins ?? {}).filter(
        ([n, ref]) => "source" in ref && (!name || n === name)
      );
      if (targets.length === 0) {
        console.log(name ? `No git plugin named "${name}".` : "No git plugins to update.");
        return;
      }

      for (const [n, ref] of targets) {
        if (!("source" in ref)) {
          continue;
        }
        const nextRef = name && options.ref ? { ...ref, ref: options.ref } : ref;
        const { commit, parsed } = await fetchGitPlugin(configDir, nextRef, n);
        await writeGitLock(configDir, n, parsed, commit);
        if (name && options.ref) {
          await updatePluginsBlock(options.config, (block) => { block[n] = nextRef; });
        }
        console.log(`${n} -> ${commit.slice(0, 12)}`);
      }
    })
  );

plugins
  .command("remove")
  .description("Remove a plugin from tack.config.json")
  .argument("<name>")
  .option("-c, --config <path>", "config path", DEFAULT_CONFIG_PATH)
  .action(async (name: string, options: { config: string }) =>
    run(async () => {
      const configDir = dirname(resolve(options.config));
      await updatePluginsBlock(options.config, (block) => {
        if (!(name in block)) {
          throw new Error(`No plugin named "${name}" in ${options.config}`);
        }
        delete block[name];
      });

      const lockPath = join(configDir, "tack.plugins.lock");
      const lock = await readLock(lockPath);
      if (lock.plugins[name]) {
        await writeLock(lockPath, withoutLockEntry(lock, name));
      }
      console.log(`Removed plugin ${name} (cache under .tack/plugins left in place)`);
    })
  );

program
  .command("mcp")
  .description("Start Tack's agent-facing MCP server over stdio")
  .option("-c, --config <path>", "config path", DEFAULT_CONFIG_PATH)
  .action(async (options: { config: string }) =>
    run(async () => {
      const { config, manifest } = await loadWorkspace(options.config);
      const runtime = await createRuntime({ config, manifest });
      const codeRuntime = createCodeRuntime(config);
      const policy = createOperationPolicy(config);
      const onAuditEvent = createAuditSink(config);
      const delegate = createDelegateOptions(config);
      const typecheck = createTypecheckOptions(config, manifest, policy);
      const handle = serveTackMcpStdio({
        manifest,
        runtime,
        codeRuntime,
        ...(policy ? { policy } : {}),
        ...(onAuditEvent ? { onAuditEvent } : {}),
        ...(delegate ? { delegate } : {}),
        ...(typecheck ? { typecheck } : {})
      });

      await waitForStdinClose();
      await Promise.allSettled([handle.close(), runtime.close()]);
    })
  );

program
  .command("host")
  .description("Start Tack's hosted MCP Streamable HTTP server with optional bearer auth")
  .option("-c, --config <path>", "config path", DEFAULT_CONFIG_PATH)
  .option("--host <host>", "host override")
  .option("--port <port>", "port override")
  .option("--path <path>", "MCP endpoint path", "/mcp")
  .action(async (options: { config: string; host?: string; port?: string; path: string }) =>
    run(async () => {
      const { config, manifest } = await loadWorkspace(options.config);
      const users = config.service?.users ?? [];
      const runtime = await createRuntime({ config, manifest });
      const codeRuntime = createCodeRuntime(config);
      const policy = createOperationPolicy(config);
      const onAuditEvent = createAuditSink(config);
      const typecheck = createTypecheckOptions(config, manifest, policy);
      const handle = await listenTackMcpHttp({
        manifest,
        runtime,
        codeRuntime,
        users,
        ...(policy ? { policy } : {}),
        ...(onAuditEvent ? { onAuditEvent } : {}),
        ...(typecheck ? { typecheck } : {})
      }, {
        host: options.host ?? config.service?.host,
        port: options.port ? parsePort(options.port) : config.service?.port,
        path: options.path
      });

      console.log(`Tack MCP listening at ${handle.url}`);
      await waitForShutdown();
      await Promise.allSettled([handle.close(), runtime.close()]);
    })
  );

program
  .command("serve")
  .description("Start Tack's authenticated HTTP JSON service")
  .option("-c, --config <path>", "config path", DEFAULT_CONFIG_PATH)
  .option("--host <host>", "host override")
  .option("--port <port>", "port override")
  .action(async (options: { config: string; host?: string; port?: string }) =>
    run(async () => {
      const { config, manifest } = await loadWorkspace(options.config);
      const users = config.service?.users ?? [];
      if (users.length === 0) {
        throw new Error("tack serve requires service.users with at least one bearer token");
      }

      const runtime = await createRuntime({ config, manifest });
      const codeRuntime = createCodeRuntime(config);
      const policy = createOperationPolicy(config);
      const onAuditEvent = createAuditSink(config);
      const typecheck = createTypecheckOptions(config, manifest, policy);
      const handle = await listenTackHttpService({
        manifest,
        runtime,
        codeRuntime,
        users,
        ...(policy ? { policy } : {}),
        ...(config.service?.maxRequestBytes ? { maxRequestBytes: config.service.maxRequestBytes } : {}),
        ...(config.service?.rateLimit ? { rateLimit: config.service.rateLimit } : {}),
        ...(onAuditEvent ? { onAuditEvent } : {}),
        ...(typecheck ? { typecheck } : {})
      }, {
        host: options.host ?? config.service?.host,
        port: options.port ? parsePort(options.port) : config.service?.port
      });

      console.log(`Tack service listening at ${handle.url}`);
      await waitForShutdown();
      await Promise.allSettled([handle.close(), runtime.close()]);
    })
  );

await program.parseAsync();

async function run(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(formatCliError(error));
    process.exitCode = 1;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function parseJsonArgs(input: string): Record<string, unknown> {
  const parsed = JSON.parse(input) as unknown;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }

  throw new Error("--json must be a JSON object");
}

function parsePort(input: string): number {
  const port = Number(input);
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    return port;
  }

  throw new Error(`Invalid port: ${input}`);
}

async function loadWorkspace(configPath: string): Promise<{
  readonly config: TackConfig;
  readonly manifest: TackManifest;
}> {
  const configDir = dirname(resolve(configPath));
  const config = await resolvePluginsIntoConfig(
    await loadConfigPromise(configPath),
    { configDir }
  );
  const manifest = await discoverManifest(config, { configDir });
  return { config, manifest };
}

/** Read tack.config.json as a mutable plain object (preserves unknown keys). */
async function readConfigObject(configPath: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (cause) {
    throw new Error(`Cannot read ${configPath}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${configPath} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function createOperationPolicy(config: TackConfig): OperationPolicy | undefined {
  const security = config.security;
  if (!security?.allowedOperations && !security?.deniedOperations) {
    return undefined;
  }

  return {
    ...(security.allowedOperations ? { allowedOperations: security.allowedOperations } : {}),
    ...(security.deniedOperations ? { deniedOperations: security.deniedOperations } : {})
  };
}

function createDelegateOptions(config: TackConfig): DelegateOptions | undefined {
  const delegate = config.delegate;
  if (!delegate?.model) {
    return undefined;
  }
  // The `delegate` tool is experimental and not ready for general use. It stays
  // unregistered unless explicitly opted into via TACK_DELEGATE_EXPERIMENTAL.
  if (!process.env.TACK_DELEGATE_EXPERIMENTAL) {
    return undefined;
  }
  const apiKeyEnv = delegate.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    console.warn(
      `[tack] delegate is configured (model ${delegate.model}) but ${apiKeyEnv} is not set; ` +
        "the delegate tool will not be registered."
    );
    return undefined;
  }
  return {
    planner: createAnthropicPlanner({
      model: delegate.model,
      apiKey,
      ...(delegate.baseUrl ? { baseUrl: delegate.baseUrl } : {})
    }),
    ...(delegate.replans !== undefined ? { replans: delegate.replans } : {})
  };
}

/**
 * Build the pre-run typechecker. On by default (`mode: "error"`); a `typecheck`
 * block in the config can set `warn`/`off`. Any failure to construct the checker
 * degrades to "off" with a warning — a missing checker never blocks execution.
 */
function createTypecheckOptions(
  config: TackConfig,
  manifest: TackManifest,
  policy: OperationPolicy | undefined
): CreateExecutionEngineOptions["typecheck"] {
  const mode = config.typecheck?.mode ?? "error";
  if (mode === "off") {
    return undefined;
  }
  try {
    return { checker: createTypeChecker({ manifest, ...(policy ? { policy } : {}) }), mode };
  } catch (error) {
    console.warn(`[tack] typecheck unavailable, running without it: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

function createAuditSink(config: TackConfig): ((event: ToolAuditEvent) => Promise<void>) | undefined {
  const path = config.security?.auditLog?.path;
  if (!path) {
    return undefined;
  }

  return async (event) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
  };
}

function toolCount(manifest: { readonly tools: Readonly<Record<string, unknown>> }) {
  return Object.keys(manifest.tools).length;
}

function groupOperationsByServer(
  operations: readonly TackOperation[]
): Map<string, TackOperation[]> {
  const grouped = new Map<string, TackOperation[]>();
  for (const operation of operations) {
    const serverOperations = grouped.get(operation.serverId) ?? [];
    serverOperations.push(operation);
    grouped.set(operation.serverId, serverOperations);
  }

  return grouped;
}

function resolveCallTarget(
  manifest: TackManifest,
  path: string,
  policyConfigured: boolean
): { readonly toolId: string; readonly operation?: TackOperation | undefined } {
  const operation = findOperation(manifest, path);
  if (operation) {
    return { toolId: operation.toolId, operation };
  }

  if (!policyConfigured) {
    return { toolId: path };
  }

  const operations = listOperations(manifest).filter((candidate) => candidate.toolId === path);
  if (operations.length === 1) {
    return { toolId: path, operation: operations[0] };
  }

  if (operations.length > 1) {
    throw new Error(`Canonical tool ID is ambiguous under policy: ${path}. Use an inferred operation path.`);
  }

  throw new Error(`Cannot apply policy to unknown operation or tool: ${path}`);
}

async function emitCliCallAudit(
  sink: ((event: ToolAuditEvent) => Promise<void>) | undefined,
  event: ToolAuditEvent
): Promise<void> {
  if (!sink) {
    return;
  }

  await sink(event);
}

function createCodeRuntime(config: TackConfig) {
  const commonOptions = {
    ...(config.runtime?.timeoutMs ? { timeoutMs: config.runtime.timeoutMs } : {}),
    ...(config.runtime?.toolTimeoutMs ? { toolTimeoutMs: config.runtime.toolTimeoutMs } : {}),
    ...(config.runtime?.memoryMb ? { memoryMb: config.runtime.memoryMb } : {}),
    ...(config.runtime?.maxOutputBytes ? { maxOutputBytes: config.runtime.maxOutputBytes } : {}),
    ...(config.runtime?.maxToolCalls ? { maxToolCalls: config.runtime.maxToolCalls } : {}),
    ...(config.runtime?.maxToolRequestBytes ? { maxToolRequestBytes: config.runtime.maxToolRequestBytes } : {}),
    ...(config.runtime?.maxToolResponseBytes ? { maxToolResponseBytes: config.runtime.maxToolResponseBytes } : {}),
    ...(config.runtime?.maxInlineResultBytes ? { maxInlineResultBytes: config.runtime.maxInlineResultBytes } : {})
  };

  return config.runtime?.type === "workerd"
    ? createWorkerdRuntime(commonOptions)
    : createQuickJSRuntime({
      ...commonOptions,
      ...(config.runtime?.maxStackBytes ? { maxStackBytes: config.runtime.maxStackBytes } : {})
    });
}

async function resolveExecutionSource(
  inlineCode: string | undefined,
  filePath: string | undefined
): Promise<string> {
  if (inlineCode && filePath) {
    throw new Error("Pass code inline, with --file, or through stdin, not more than one");
  }

  if (filePath) {
    return readFile(filePath, "utf8");
  }

  if (inlineCode) {
    return inlineCode;
  }

  if (process.stdin.isTTY) {
    throw new Error("No code provided. Pass inline code, --file, or pipe code through stdin");
  }

  let source = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    source += chunk;
  }
  if (!source.trim()) {
    throw new Error("Execution code is empty");
  }
  return source;
}

function printExecutionResult(result: ExecutionResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.typeDiagnostics?.length) {
    const heading = result.error?.phase === "typecheck"
      ? "Type error — nothing ran:"
      : `${result.typeDiagnostics.length} type warning(s):`;
    console.error(`${heading}\n${formatTypeDiagnostics(result.typeDiagnostics)}`);
  }
  for (const value of result.emitted) {
    console.log(formatExecutionValue(value));
  }
  for (const line of result.logs) {
    console.error(line);
  }
  if (result.ok && "result" in result) {
    console.log(formatExecutionValue(result.result));
  } else if (result.error && result.error.phase !== "typecheck") {
    console.error(`${result.error.phase}: ${result.error.message}`);
  }
}

function formatExecutionValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2) ?? "undefined";
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function waitForStdinClose(): Promise<void> {
  if (process.stdin.destroyed) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    process.stdin.once("close", resolve);
    process.stdin.once("end", resolve);
  });
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}
