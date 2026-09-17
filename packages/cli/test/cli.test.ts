import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { execa } from "execa";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const cliSource = join(repoRoot, "packages", "cli", "src", "index.ts");
const fakeServer = join(repoRoot, "packages", "mcp", "test", "fixtures", "fake-mcp-server.mjs");
const pluginFixture = join(repoRoot, "packages", "plugin", "test", "fixtures", "acme-plugin");

let tmpPath: string | undefined;

afterEach(async () => {
  if (tmpPath) {
    await rm(tmpPath, { recursive: true, force: true });
    tmpPath = undefined;
  }
});

describe("CLI", () => {
  it("enables direct-import project types once and refreshes them with build", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-cli-sdk-"));
    const configPath = join(tmpPath, "tack.config.json");
    await writeFile(configPath, JSON.stringify({ servers: { example: { transport: "stdio", command: "node", args: [fakeServer] } }, storage: { root: "./storage" } }));
    await writeFile(join(tmpPath, "script.ts"), 'import { Tack } from "@cbxss/tack-sdk";\n');
    await writeFile(join(tmpPath, "tsconfig.json"), '{ // preserve settings\n"compilerOptions":{"strict":true}, "files":["script.ts"]}');
    const init = await runCli(["init", "--sdk", "--config", configPath], tmpPath);
    expect(init.stdout).toContain("SDK project types enabled");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.servers.example.args).toEqual([fakeServer]);
    expect(config.storage).toEqual({ root: "./storage" });
    expect(config.sdk).toEqual({ tsconfig: "./tsconfig.json" });
    const build = await runCli(["build", "--config", configPath], tmpPath);
    expect(build.stdout).toContain('import { Tack } from "@cbxss/tack-sdk"');
    const tsconfig = await readFile(join(tmpPath, "tsconfig.json"), "utf8");
    expect(tsconfig).toContain("// preserve settings");
    expect(tsconfig).toContain('"script.ts"');
    const declaration = tsconfig.match(/\.tack\/types\/[a-f0-9]+\.d\.ts/u)![0];
    const types = await readFile(join(tmpPath, declaration), "utf8");
    expect(types).toContain('"./tack.config.json": ProjectTools');
    expect(types).toContain('readonly "example"');
    await expect(readFile(join(tmpPath, ".tack/generated/index.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await runCli(["build", "--config", configPath], tmpPath);
    expect(await readFile(join(tmpPath, "tsconfig.json"), "utf8")).toBe(tsconfig);
    expect(await readFile(join(tmpPath, declaration), "utf8")).toBe(types);
    const removed = await runCli(["generate", "--live", "--config", configPath], tmpPath, { reject: false });
    expect(removed.exitCode).toBe(1);
    expect(removed.stderr).toContain("unknown option");
  });

  it("anchors SDK projects to a config-relative custom tsconfig", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-cli-sdk-project-"));
    await mkdir(join(tmpPath, "configs"));
    const configPath = join(tmpPath, "configs/staging.json");
    await writeFile(configPath, JSON.stringify({ servers: { staging: { transport: "stdio", command: "node", args: [fakeServer] } } }));
    await runCli(["init", "--sdk", "--config", configPath, "--tsconfig", "../tsconfig.json"], tmpPath);
    await runCli(["init", "--sdk", "--config", configPath], tmpPath);
    expect(JSON.parse(await readFile(configPath, "utf8")).sdk.tsconfig).toBe("../tsconfig.json");
    await runCli(["build", "--config", configPath], join(tmpPath, "configs"));
    const project = JSON.parse(await readFile(join(tmpPath, "tsconfig.json"), "utf8"));
    const declaration = await readFile(join(tmpPath, project.files[0]), "utf8");
    expect(declaration).toContain('readonly "./configs/staging.json": ProjectTools');
    expect(declaration).not.toContain('readonly "tack.config.json": ProjectTools');
  });

  it("initializes, generates, inspects, and calls tools", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-cli-"));
    const configPath = join(tmpPath, "tack.config.json");
    const outDir = join(tmpPath, ".tack", "generated");
    const auditPath = join(tmpPath, ".tack", "audit.jsonl");
    const skillOutDir = join(tmpPath, "skills");

    const missingDoctor = await runCli([
      "doctor",
      "--config",
      configPath,
      "--no-discovery"
    ], tmpPath, { reject: false });
    expect(missingDoctor.exitCode).toBe(1);
    expect(missingDoctor.stdout).toContain("[fail] Config not found");

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

    const staticDoctor = await runCli([
      "doctor",
      "--config",
      configPath,
      "--no-discovery"
    ], tmpPath);
    expect(staticDoctor.stdout).toContain("[ok] Found config");
    expect(staticDoctor.stdout).toContain("[warn] Skipped live source discovery");

    const liveDoctor = await runCli(["doctor", "--config", configPath], tmpPath);
    expect(liveDoctor.stdout).toContain("[ok] Discovered");

    const skillPrint = await runCli(["skill", "print"], tmpPath);
    expect(skillPrint.stdout).toContain("name: tack");
    expect(skillPrint.stdout).toContain("tack doctor");

    const skillInstall = await runCli(["skill", "install", "--out", skillOutDir], tmpPath);
    expect(skillInstall.stdout).toContain(join(skillOutDir, "tack"));
    const skillMarkdown = await readFile(join(skillOutDir, "tack", "SKILL.md"), "utf8");
    expect(skillMarkdown).toContain("description: Work with Tack");
    expect(skillMarkdown).toContain("tack inspect");
    const openAiYaml = await readFile(join(skillOutDir, "tack", "agents", "openai.yaml"), "utf8");
    expect(openAiYaml).toContain("display_name: Tack");
    const duplicateSkillInstall = await runCli(
      ["skill", "install", "--out", skillOutDir],
      tmpPath,
      { reject: false }
    );
    expect(duplicateSkillInstall.exitCode).toBe(1);
    expect(duplicateSkillInstall.stderr).toContain("Refusing to overwrite existing skill");
    const forcedSkillInstall = await runCli([
      "skill",
      "install",
      "--out",
      skillOutDir,
      "--force"
    ], tmpPath);
    expect(forcedSkillInstall.stdout).toContain(join(skillOutDir, "tack"));

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
    await expect(readFile(join(outDir, "sdk/client.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const legacyBuild = await runCli(["build", "--config", configPath], tmpPath);
    expect(legacyBuild.stdout).toContain("TypeScript SDK");
    await expect(readFile(join(tmpPath, "tsconfig.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
    expect(docs).toContain('await tools.example.add({ "a": 0, "b": 0 })');

    const inspect = await runCli(["inspect", "--config", configPath], tmpPath);
    expect(inspect.stdout).toContain("example.add -> example.add");
    expect(inspect.stdout).toContain("example.echo -> example.echo");
    expect(inspect.stdout).toContain(
      'example.rules.list -> example.manage_rules {"operation":"list"}'
    );

    const executed = await runCli([
      "execute",
      "const r = await tools.example.echo({ message: 'from execute' });\nreturn r.ok ? r.data : r.error;",
      "--config",
      configPath,
      "--json"
    ], tmpPath);
    expect(JSON.parse(executed.stdout)).toMatchObject({
      status: "completed",
      result: { message: "from execute" }
    });

    // Explicit strict checking blocks a cell with a bad argument key.
    const badArg = await runCli([
      "execute",
      "return await tools.example.echo({ mesage: 'typo' });",
      "--typecheck", "strict",
      "--config",
      configPath,
      "--json"
    ], tmpPath, { reject: false });
    expect(badArg.exitCode).toBe(1);
    expect(JSON.parse(badArg.stdout)).toMatchObject({
      status: "error",
      error: { phase: "typecheck" }
    });

    const codePath = join(tmpPath, "probe.ts");
    await writeFile(codePath, "const value: number = 2; return value + 3;", "utf8");
    const fileExecuted = await runCli([
      "execute",
      "--file",
      codePath,
      "--config",
      configPath
    ], tmpPath);
    expect(fileExecuted.stdout).toBe("5");

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

  it("adds, lists, runs, and removes a local plugin", async () => {
    tmpPath = await mkdtemp(join(tmpdir(), "tack-cli-plugin-"));
    const configPath = join(tmpPath, "tack.config.json");
    await writeFile(configPath, `${JSON.stringify({ servers: {} }, null, 2)}\n`, "utf8");

    const added = await runCli(
      ["plugins", "add", pluginFixture, "--as", "acme", "--config", configPath],
      tmpPath
    );
    expect(added.stdout).toContain("Added plugin acme");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.plugins.acme).toEqual({ path: pluginFixture });

    const list = await runCli(["plugins", "list", "--config", configPath], tmpPath);
    expect(list.stdout).toContain("acme");

    const inspect = await runCli(["inspect", "--config", configPath], tmpPath);
    expect(inspect.stdout).toContain("acme.greet");
    expect(inspect.stdout).toContain("acme.mcp.echo.echo");

    const executed = await runCli(
      [
        "execute",
        "const s = await tools.acme.greet(); return s.ok ? s.data.name : s.error;",
        "--config",
        configPath,
        "--json"
      ],
      tmpPath
    );
    expect(JSON.parse(executed.stdout)).toMatchObject({ status: "completed", result: "greet" });

    const removed = await runCli(["plugins", "remove", "acme", "--config", configPath], tmpPath);
    expect(removed.stdout).toContain("Removed plugin acme");
    expect(JSON.parse(await readFile(configPath, "utf8")).plugins).toBeUndefined();
  }, 20_000);
});

function runCli(
  args: readonly string[],
  cwd: string,
  options: { readonly reject?: boolean } = {}
) {
  return execa(process.execPath, [cliSource.replace("/src/", "/dist/").replace(/\.ts$/u, ".js"), ...args], { cwd, reject: options.reject ?? true });
}
