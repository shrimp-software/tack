import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildManifest } from "@cbxss/tack-core";
import { generateProjectTypesPromise, generateSdkPromise } from "../src/index.js";
import { GENERATED_FILE_HEADER } from "../src/types.js";

const temporary: string[] = [];
async function temp() {
  const path = await mkdtemp(join(tmpdir(), "tack-project-types-"));
  temporary.push(path);
  return path;
}
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
function manifest(serverId = "local") {
  return buildManifest({ servers: { [serverId]: { transport: "stdio", command: "unused" } } }, [
    { serverId, tools: [
      { name: "echo", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, outputSchema: { type: "string" } },
      { name: "status", inputSchema: { type: "object" } },
      { name: "name", inputSchema: {} }
    ] }
  ]);
}

describe("project SDK declarations", () => {
  it("binds exact config paths without a client, globals, index signatures, or runtime code", async () => {
    const projectDir = await temp();
    const path = await generateProjectTypesPromise({ manifest: manifest(), projectDir, configPath: "./tack.config.json" });
    const text = await readFile(path, "utf8");
    expect(path).toMatch(/\.tack\/types\/[0-9a-f]+\.d\.ts$/u);
    expect(text).toContain('declare module "@cbxss/tack-sdk"');
    expect(text).toContain('readonly "./tack.config.json": ProjectTools');
    expect(text).toContain('readonly "tack.config.json": ProjectTools');
    expect(text).toContain('readonly "echo": TackTool<(args: LocalEchoInput, options?: TackCallOptions) => Promise<TackResponse<LocalEchoOutput>>>');
    expect(text).toContain('readonly "status": TackTool<(args?: LocalStatusInput');
    expect(text).toContain('export type LocalStatusOutput = unknown');
    for (const absent of ['class Tack', 'declare global', 'tools.d.ts', 'Schema.', 'readonly "name"', '[key:', '[namespace:']) expect(text).not.toContain(absent);
    expect(await readdir(projectDir)).toEqual([".tack"]);
  });

  it("refreshes one config without deleting declarations for another or manual files", async () => {
    const projectDir = await temp();
    const primary = await generateProjectTypesPromise({ manifest: manifest(), projectDir, configPath: "./tack.config.json" });
    const other = await generateProjectTypesPromise({ manifest: manifest("other"), projectDir, configPath: "./config/other.json" });
    const before = await readFile(other, "utf8");
    await writeFile(join(dirname(primary), "manual.d.ts"), "// manual");
    expect(await generateProjectTypesPromise({ manifest: manifest("next"), projectDir, configPath: join(projectDir, "tack.config.json") })).toBe(primary);
    expect(await readFile(primary, "utf8")).toContain('readonly "next"');
    expect(await readFile(primary, "utf8")).not.toContain('readonly "local"');
    expect(await readFile(other, "utf8")).toBe(before);
    expect(await readFile(join(dirname(primary), "manual.d.ts"), "utf8")).toBe("// manual");
  });

  it("refuses manual declaration targets and outside-project configs", async () => {
    const projectDir = await temp();
    const options = { manifest: manifest(), projectDir, configPath: "./tack.config.json" };
    const path = await generateProjectTypesPromise(options);
    await writeFile(path, "// manual");
    await expect(generateProjectTypesPromise(options)).rejects.toThrow("Refusing to overwrite");
    expect(await readFile(path, "utf8")).toBe("// manual");
    await expect(generateProjectTypesPromise({ ...options, configPath: "../outside.json" })).rejects.toThrow("inside the TypeScript project");
    expect((await readdir(dirname(path))).some(name => name.startsWith(".stage-"))).toBe(false);
  });

  it.each([".tack", ".tack/types", "target", "dangling"])("does not follow %s symlinks", async kind => {
    const projectDir = await temp();
    const outside = await temp();
    const marker = join(outside, "marker.d.ts");
    await writeFile(marker, GENERATED_FILE_HEADER + "\n// external");
    const options = { manifest: manifest(), projectDir, configPath: "./tack.config.json" };
    if (kind === "target" || kind === "dangling") {
      const path = await generateProjectTypesPromise(options);
      await rm(path);
      await symlink(kind === "target" ? marker : join(outside, "missing"), path);
    } else {
      if (kind === ".tack/types") await mkdir(join(projectDir, ".tack"));
      await symlink(outside, join(projectDir, kind));
    }
    await expect(generateProjectTypesPromise(options)).rejects.toThrow(/symlink/u);
    expect(await readFile(marker, "utf8")).toBe(GENERATED_FILE_HEADER + "\n// external");
    expect(await readdir(outside)).toEqual(["marker.d.ts"]);
  });

  it("supports a trusted symlinked project root", async () => {
    const root = await temp();
    const project = await temp();
    const link = join(root, "project");
    await symlink(project, link);
    const path = await generateProjectTypesPromise({ manifest: manifest(), projectDir: link, configPath: join(link, "tack.config.json") });
    expect(await readFile(path, "utf8")).toContain('"./tack.config.json": ProjectTools');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("leaves legacy static output unchanged and SDK-free", async () => {
    const projectDir = await temp();
    const outDir = join(projectDir, "legacy");
    await generateSdkPromise({ manifest: manifest(), outDir });
    const before = await readFile(join(outDir, "index.ts"), "utf8");
    await generateProjectTypesPromise({ manifest: manifest(), projectDir, configPath: "./tack.config.json" });
    await generateSdkPromise({ manifest: manifest(), outDir });
    expect(await readFile(join(outDir, "index.ts"), "utf8")).toBe(before);
    for (const file of await readdir(outDir)) expect(await readFile(join(outDir, file), "utf8")).not.toContain('@cbxss/tack-sdk"');
    await expect(lstat(join(outDir, "sdk"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
