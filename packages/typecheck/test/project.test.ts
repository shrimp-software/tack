import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript-5";
import { includeProjectDeclaration } from "../src/project.js";

const directories: string[] = [];
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "tack-tsconfig-"));
  directories.push(directory);
  const config = join(directory, "tsconfig.json");
  const declaration = join(directory, "tack-env.d.ts");
  await writeFile(declaration, "export {};\n");
  await writeFile(join(directory, "script.ts"), "export {};\n");
  return { directory, config, declaration };
}
function parse(path: string) {
  return ts.getParsedCommandLineOfConfigFile(path, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => { throw new Error("parse failure"); } })!;
}
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("project declaration inclusion", () => {
  it("creates a minimal TypeScript project without disabling source discovery", async () => {
    const { directory, config, declaration } = await setup();
    await includeProjectDeclaration(config, declaration);
    const parsed = parse(config);
    expect(parsed.errors).toEqual([]);
    expect(parsed.fileNames).toContain(declaration);
    expect(parsed.fileNames).toContain(join(directory, "script.ts"));
    expect(parsed.raw.exclude).toContain(".tack/generated");
    expect(parsed.options.types).toEqual(["node"]);
  });

  it.each(["mts", "cts", "tsx"])("includes and typechecks .%s scripts in a new project", async extension => {
    const { directory, config, declaration } = await setup();
    const script = join(directory, `extension-example.${extension}`);
    await writeFile(script, 'const impossible: number = "wrong"; export {};');
    await includeProjectDeclaration(config, declaration);
    const parsed = parse(config);
    expect(parsed.fileNames).toContain(script);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    // Assert the intentional source diagnostic, not an unrelated environment error.
    const errors = ts.getPreEmitDiagnostics(program).filter(error => error.file?.fileName === script);
    expect(errors.map(error => error.code)).toContain(2322);
  });

  it("preserves explicit compiler type selections in existing projects", async () => {
    const { config, declaration } = await setup();
    await writeFile(config, '{"compilerOptions":{"types":[],"lib":["es2022"]},"files":["script.ts"]}');
    await includeProjectDeclaration(config, declaration);
    expect(parse(config).options.types).toEqual([]);
    expect(parse(config).raw.compilerOptions.lib).toEqual(["es2022"]);
  });

  it.each([
    '{ // keep comment\n "compilerOptions": {"strict": true,},\n}',
    '{"files": ["script.ts" // file comment\n]}',
    '{"files": ["script.ts", // trailing comma\n]}',
    '{"files": [], "include": ["script.ts"]}',
    '{"include": ["script.ts"], "exclude": ["vendor"]}'
  ])("preserves JSONC, files/globs and compiler options in %s", async text => {
    const { directory, config, declaration } = await setup();
    await writeFile(config, text);
    await includeProjectDeclaration(config, declaration);
    const after = await readFile(config, "utf8");
    for (const comment of text.match(/\/\/[^\n]*/gu) ?? []) expect(after).toContain(comment);
    const parsed = parse(config);
    expect(parsed.errors).toEqual([]);
    expect(parsed.fileNames).toContain(declaration);
    expect(parsed.fileNames).toContain(join(directory, "script.ts"));
    await includeProjectDeclaration(config, declaration);
    expect(await readFile(config, "utf8")).toBe(after);
  });

  it("retains rebased inherited files and globs without editing the base", async () => {
    const { directory, config, declaration } = await setup();
    const base = join(directory, "base");
    await mkdir(base);
    await writeFile(join(base, "entry.ts"), "export {};\n");
    const baseConfig = '{"files":["entry.ts"], "include":["*.ts"], "compilerOptions":{"strict":true}}';
    await writeFile(join(base, "tsconfig.json"), baseConfig);
    await writeFile(config, '{"extends":"./base/tsconfig.json"}');
    const before = parse(config).fileNames;
    await includeProjectDeclaration(config, declaration);
    expect(parse(config).fileNames).toEqual(expect.arrayContaining([...before, declaration]));
    expect(parse(config).options.strict).toBe(true);
    expect(await readFile(join(base, "tsconfig.json"), "utf8")).toBe(baseConfig);
  });

  it("adds multiple catalog declarations without duplicating entries", async () => {
    const { directory, config, declaration } = await setup();
    await includeProjectDeclaration(config, declaration);
    const second = join(directory, "other.d.ts");
    await writeFile(second, "export {};\n");
    await includeProjectDeclaration(config, second);
    await includeProjectDeclaration(config, declaration);
    expect(parse(config).raw.files).toEqual(["tack-env.d.ts", "other.d.ts"]);
  });

  it("rejects malformed JSON, broken extends and symlink targets without changes", async () => {
    const { directory, config, declaration } = await setup();
    for (const text of ['{"files": [', '{"extends":"./missing.json"}', '{"files":false}', '{"files":[],"files":[]}', '{"files":[],"references":[{"path":"./app"}]}']) {
      await writeFile(config, text);
      await expect(includeProjectDeclaration(config, declaration)).rejects.toThrow();
      expect(await readFile(config, "utf8")).toBe(text);
    }
    const outside = join(directory, "external.json");
    await writeFile(outside, "{}");
    await rm(config);
    await symlink(outside, config);
    await expect(includeProjectDeclaration(config, declaration)).rejects.toThrow("symlink");
    expect(await readFile(outside, "utf8")).toBe("{}");
  });
});
