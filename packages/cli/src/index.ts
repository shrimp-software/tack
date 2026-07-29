#!/usr/bin/env node
import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Command } from "commander";
import { listenTackMcpHttp, serveTackMcpStdio } from "@tack/agent";
import { isOperationAllowed, type OperationPolicy, type ToolAuditEvent } from "@tack/codemode";
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_OUTPUT_DIR,
  createDefaultConfig,
  findOperation,
  listOperations,
  loadConfigPromise,
  operationArgs,
  type TackConfig,
  type TackManifest,
  type TackOperation,
  writeJsonPromise
} from "@tack/core";
import { generateDocsPromise, generateSdkPromise } from "@tack/generator";
import { createMcpRuntime, discoverMcpManifestPromise } from "@tack/mcp";
import { createQuickJSRuntime } from "@tack/runtime-quickjs";
import { createWorkerdRuntime } from "@tack/runtime-workerd";
import { listenTackHttpService } from "@tack/service";
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
        const runtime = await createMcpRuntime({ config, manifest });
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

program
  .command("mcp")
  .description("Start Tack's agent-facing MCP server over stdio")
  .option("-c, --config <path>", "config path", DEFAULT_CONFIG_PATH)
  .action(async (options: { config: string }) =>
    run(async () => {
      const { config, manifest } = await loadWorkspace(options.config);
      const runtime = await createMcpRuntime({ config, manifest });
      const codeRuntime = createCodeRuntime(config);
      const policy = createOperationPolicy(config);
      const onAuditEvent = createAuditSink(config);
      const handle = serveTackMcpStdio({
        manifest,
        runtime,
        codeRuntime,
        ...(policy ? { policy } : {}),
        ...(onAuditEvent ? { onAuditEvent } : {})
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
      const runtime = await createMcpRuntime({ config, manifest });
      const codeRuntime = createCodeRuntime(config);
      const policy = createOperationPolicy(config);
      const onAuditEvent = createAuditSink(config);
      const handle = await listenTackMcpHttp({
        manifest,
        runtime,
        codeRuntime,
        users,
        ...(policy ? { policy } : {}),
        ...(onAuditEvent ? { onAuditEvent } : {})
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

      const runtime = await createMcpRuntime({ config, manifest });
      const codeRuntime = createCodeRuntime(config);
      const policy = createOperationPolicy(config);
      const onAuditEvent = createAuditSink(config);
      const handle = await listenTackHttpService({
        manifest,
        runtime,
        codeRuntime,
        users,
        ...(policy ? { policy } : {}),
        ...(config.service?.maxRequestBytes ? { maxRequestBytes: config.service.maxRequestBytes } : {}),
        ...(config.service?.rateLimit ? { rateLimit: config.service.rateLimit } : {}),
        ...(onAuditEvent ? { onAuditEvent } : {})
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
  const config = await loadConfigPromise(configPath);
  const manifest = await discoverMcpManifestPromise(config);
  return { config, manifest };
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
    ...(config.runtime?.memoryMb ? { memoryMb: config.runtime.memoryMb } : {}),
    ...(config.runtime?.maxOutputBytes ? { maxOutputBytes: config.runtime.maxOutputBytes } : {}),
    ...(config.runtime?.maxToolCalls ? { maxToolCalls: config.runtime.maxToolCalls } : {}),
    ...(config.runtime?.maxToolRequestBytes ? { maxToolRequestBytes: config.runtime.maxToolRequestBytes } : {}),
    ...(config.runtime?.maxToolResponseBytes ? { maxToolResponseBytes: config.runtime.maxToolResponseBytes } : {})
  };

  return config.runtime?.type === "workerd"
    ? createWorkerdRuntime(commonOptions)
    : createQuickJSRuntime({
      ...commonOptions,
      ...(config.runtime?.maxStackBytes ? { maxStackBytes: config.runtime.maxStackBytes } : {})
    });
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
