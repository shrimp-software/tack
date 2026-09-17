import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { hasRequiredInput, isSafeToolProxySegment, type TackManifest } from "@cbxss/tack-core";
import { buildMethodTree, compileSchema, renderInterfaceTree } from "@cbxss/tack-sdk-types";
import { plannedOperations, toGeneratedMethods } from "./methods.js";
import { assertRuntimeManifestServerCoverage, assertVisibleManifestToolsArePlannable } from "./manifest-checks.js";
import { GENERATED_FILE_HEADER } from "./types.js";

/** Build declarations only: no runtime client, globals, or legacy generated imports. */
export async function writeProjectTypes(manifest: TackManifest, projectDir: string, configPath: string): Promise<string> {
  const project = resolve(projectDir);
  const key = relative(project, resolve(project, configPath)).split(sep).join("/");
  if (!key || key === ".." || key.startsWith("../") || isAbsolute(key)) {
    throw new Error("SDK type bindings require a config inside the TypeScript project directory");
  }
  assertVisibleManifestToolsArePlannable(manifest);
  const methods = toGeneratedMethods(plannedOperations(manifest));
  assertRuntimeManifestServerCoverage(manifest, methods);
  const chunks = [GENERATED_FILE_HEADER,
    'import type { TackCallOptions, TackResponse, TackTool, TackToolNamespace } from "@cbxss/tack-sdk";',
    `// Config paths are relative to the project working directory: ${JSON.stringify(key)}`,
    "// Schema snapshot only; live validation and authorization still apply.", ""];
  for (const method of methods) {
    chunks.push(await compileSchema(method.inputSchema, method.inputType, { context: "project SDK types" }));
    chunks.push(method.outputSchema
      ? await compileSchema(method.outputSchema, method.outputType, { context: "project SDK types" })
      : `export type ${method.outputType} = unknown;`);
  }
  const namespaced = methods
    .filter(method => [method.namespaceName, ...method.path].every(isSafeToolProxySegment))
    .map(method => ({ ...method, path: [method.namespaceName, ...method.path] }));
  chunks.push("interface ProjectTools extends TackToolNamespace {",
    ...renderInterfaceTree(buildMethodTree(namespaced), "  ", {
      namespaceType: "TackToolNamespace", callableType: "TackTool",
      result: method => `TackResponse<${method.outputType}>`,
      parameters: method => `${hasRequiredInput(method.inputSchema) ? "args" : "args?"}: ${method.inputType}, options?: TackCallOptions`
    }), "}",
    'declare module "@cbxss/tack-sdk" {', "  interface TackConfigRegistry {",
    `    readonly ${JSON.stringify(key)}: ProjectTools;`,
    `    readonly ${JSON.stringify(`./${key}`)}: ProjectTools;`, "  }", "}", "");

  // Treat the project root as trusted, not symlinked children under it.
  await mkdir(project, { recursive: true });
  const root = await realpath(project);
  let directory = root;
  for (const segment of [".tack", "types"]) {
    directory = join(directory, segment);
    const status = await fileStatus(directory);
    if (status && !status.isDirectory()) throw new Error(`SDK types directory is not a directory (symlinks are not allowed): ${directory}`);
    await mkdir(directory, { recursive: true });
  }
  const name = `${createHash("sha256").update(key).digest("hex").slice(0, 24)}.d.ts`;
  const path = join(directory, name);
  const assertTarget = async () => {
    const status = await fileStatus(path);
    if (status && (!status.isFile() || !(await readFile(path, "utf8")).startsWith(GENERATED_FILE_HEADER))) {
      throw new Error(`Refusing to overwrite non-generated or symlinked SDK types: ${path}`);
    }
  };
  await assertTarget();
  const stage = await mkdtemp(join(directory, ".stage-"));
  try {
    await writeFile(join(stage, name), chunks.join("\n"), "utf8");
    await assertTarget();
    await rename(join(stage, name), path);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  // Preserve the caller's project spelling (including trusted ancestor symlinks).
  return join(project, ".tack", "types", name);
}

async function fileStatus(path: string) {
  try { return await lstat(path); }
  catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
}
