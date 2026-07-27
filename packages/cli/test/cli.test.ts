import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { execa } from "execa";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const cliSource = join(repoRoot, "packages", "cli", "src", "index.ts");
const fakeServer = join(repoRoot, "packages", "mcp", "test", "fixtures", "fake-mcp-server.mjs");

let tmpPath: string | undefined;

afterEach(async () => {
  if (tmpPath) {
    await rm(tmpPath, { recursive: true, force: true });
    tmpPath = undefined;
  }
});

describe("CLI", () => {
  it("initializes, generates, inspects, and calls tools", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-cli-"));
    const configPath = join(tmpPath, "tack.config.json");
    const outDir = join(tmpPath, ".tack", "generated");
    const auditPath = join(tmpPath, ".tack", "audit.jsonl");

    await runCli(["init", "--config", configPath], tmpPath);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.runtime).toMatchObject({
      type: "quickjs",
      timeoutMs: 30_000,
      memoryMb: 128,
      maxStackBytes: 1_000_000,
      maxOutputBytes: 1_000_000,
      maxToolCalls: 100
    });
    config.servers.example.command = "node";
    config.servers.example.args = [fakeServer];
    config.security = {
      deniedOperations: ["example.rules.get"],
      auditLog: {
        path: auditPath
      }
    };
    config.output = {
      dir: outDir
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const serve = await runCli(["serve", "--config", configPath], tmpPath, { reject: false });
    expect(serve.exitCode).toBe(1);
    expect(serve.stderr).toContain("tack serve requires service.users");

    config.runtime.type = "node";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const invalidRuntime = await runCli([
      "inspect",
      "--config",
      configPath
    ], tmpPath, { reject: false });
    expect(invalidRuntime.exitCode).toBe(1);
    expect(invalidRuntime.stderr).toContain("Invalid Tack config");
    config.runtime.type = "quickjs";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const generate = await runCli(["generate", "--config", configPath], tmpPath);
    expect(generate.stdout).toContain(`Generated TypeScript SDK in ${outDir}`);
    expect(await readFile(join(outDir, "index.ts"), "utf8")).toContain("createTackClient");
    const docsPath = join(tmpPath, ".tack", "tools.md");
    await runCli([
      "docs",
      "--config",
      configPath,
      "--out",
      docsPath,
      "--title",
      "Example Tools"
    ], tmpPath);
    const docs = await readFile(docsPath, "utf8");
    expect(docs).toContain("# Example Tools");
    expect(docs).toContain("### `example.add`");
    expect(docs).toContain("await tools.example.add(args)");

    const inspect = await runCli(["inspect", "--config", configPath], tmpPath);
    expect(inspect.stdout).toContain("example.add -> example.add");
    expect(inspect.stdout).toContain("example.echo -> example.echo");
    expect(inspect.stdout).toContain(
      'example.rules.list -> example.manage_rules {"operation":"list"}'
    );

    const call = await runCli(
      [
        "call",
        "example.echo",
        "--json",
        "{\"message\":\"hello\"}",
        "--config",
        configPath
      ],
      tmpPath
    );
    expect(JSON.parse(call.stdout).structuredContent).toEqual({ message: "hello" });

    const splitCall = await runCli(
      [
        "call",
        "example.rules.list",
        "--json",
        "{\"rule_uid\":\"abc\"}",
        "--config",
        configPath
      ],
      tmpPath
    );
    expect(JSON.parse(splitCall.stdout).structuredContent).toEqual({
      args: { rule_uid: "abc", operation: "list" }
    });

    config.security.deniedOperations = ["example.rules.*"];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const deniedCall = await runCli(
      [
        "call",
        "example.rules.list",
        "--json",
        "{}",
        "--config",
        configPath
      ],
      tmpPath,
      { reject: false }
    );
    expect(deniedCall.exitCode).toBe(1);
    expect(deniedCall.stderr).toContain("Operation denied by policy");

    const audit = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(audit).toEqual([
      expect.objectContaining({
        path: "example.echo",
        toolId: "example.echo",
        allowed: true,
        ok: true
      }),
      expect.objectContaining({
        path: "example.rules.list",
        toolId: "example.manage_rules",
        allowed: true,
        ok: true
      }),
      expect.objectContaining({
        path: "example.rules.list",
        toolId: "example.manage_rules",
        allowed: false,
        ok: false
      })
    ]);
  }, 15_000);
});

function runCli(
  args: readonly string[],
  cwd: string,
  options: { readonly reject?: boolean } = {}
) {
  return execa("bun", [cliSource, ...args], { cwd, reject: options.reject ?? true });
}
