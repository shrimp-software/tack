// Run after `bun run build`. All installs and generated files stay in a disposable
// consumer; npm pack never publishes and no workspace links are used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "../../..");
const temporary = await mkdtemp(join(tmpdir(), "tack-packed-consumer-"));
const consumer = join(temporary, "consumer");
const packs = join(temporary, "packs");
const forbidden = /^(?:@cbxss\/tack(?:-agent|-service|-runtime-quickjs|-runtime-workerd)?|quickjs-emscripten(?:-core)?|workerd|@jitl\/.*)$/u;
const json = async path => JSON.parse(await readFile(path, "utf8"));
function run(command, args, cwd = consumer, expectFailure = false) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 180_000 });
  if (result.error || result.status === null || (expectFailure ? result.status === 0 : result.status !== 0)) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`, { cause: result.error });
  }
  return result.stdout + (expectFailure ? result.stderr : "");
}
try {
  await mkdir(consumer);
  await mkdir(packs);
  const workspaces = new Map();
  for (const folder of await readdir(join(root, "packages"))) {
    const directory = join(root, "packages", folder);
    const manifest = await json(join(directory, "package.json"));
    workspaces.set(manifest.name, { directory, manifest });
  }
  const selected = new Map();
  function select(name) {
    if (selected.has(name)) return;
    assert.ok(!forbidden.test(name), `forbidden SDK dependency: ${name}`);
    const workspace = workspaces.get(name);
    assert.ok(workspace, `missing local package: ${name}`);
    selected.set(name, workspace);
    for (const [dependency, version] of Object.entries(workspace.manifest.dependencies ?? {})) {
      assert.ok(!forbidden.test(dependency), `forbidden SDK dependency: ${dependency}`);
      if (workspaces.has(dependency)) {
        assert.equal(version, workspaces.get(dependency).manifest.version, `internal pin: ${name} -> ${dependency}`);
        select(dependency);
      }
    }
  }
  select("@cbxss/tack-sdk");
  assert.ok(!selected.has("@cbxss/tack-generator"), "generator must not be an SDK runtime dependency");
  assert.ok(!selected.has("@cbxss/tack-typecheck"), "TypeScript project setup must not be an SDK runtime dependency");
  const runtimePackages = [...selected.keys()];
  // Project setup tooling is installed explicitly for this build-time fixture only.
  select("@cbxss/tack-generator");
  select("@cbxss/tack-typecheck");
  const dependencies = {};
  for (const [name, { directory }] of selected) {
    const [packed] = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packs], directory));
    dependencies[name] = `file:${join(packs, packed.filename)}`;
    if (name === "@cbxss/tack-sdk") {
      assert.ok(packed.files.some(file => file.path === "dist/index.d.ts"));
      assert.ok(packed.files.some(file => file.path === "dist/index.js"));
      assert.ok(!packed.files.some(file => file.path.startsWith("test/") || file.path.startsWith("src/")));
    }
  }
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true, type: "module", dependencies,
    devDependencies: { typescript: "7.0.2", "typescript-5": "npm:typescript@5.9.3", "@types/node": "22.20.2" }
  }, null, 2));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"]);
  for (const name of selected.keys()) {
    const installed = join(consumer, "node_modules", name);
    assert.equal((await lstat(installed)).isSymbolicLink(), false, `${name} must be extracted, not linked`);
    assert.ok((await realpath(installed)).startsWith(consumer + "/"));
    const manifest = await json(join(installed, "package.json"));
    const entry = manifest.exports["."];
    await readFile(join(installed, entry.types));
    await readFile(join(installed, entry.import));
  }
  const installedTree = JSON.parse(run("npm", ["ls", "--all", "--json"]));
  function checkInstalled(tree) {
    for (const [name, child] of Object.entries(tree.dependencies ?? {})) {
      assert.ok(!forbidden.test(name), `forbidden installed package: ${name}`);
      checkInstalled(child);
    }
  }
  checkInstalled(installedTree);
  // A legacy-only install must recursively compile default regenerated output
  // without @cbxss/tack-sdk (including its transitive dependencies) being present.
  const legacy = join(temporary, "legacy");
  await mkdir(legacy);
  const legacyDependencies = {};
  function selectLegacy(name) {
    if (legacyDependencies[name]) return;
    legacyDependencies[name] = dependencies[name];
    assert.ok(legacyDependencies[name], `legacy tarball missing: ${name}`);
    for (const dependency of Object.keys(workspaces.get(name).manifest.dependencies ?? {})) {
      if (workspaces.has(dependency)) selectLegacy(dependency);
    }
  }
  for (const name of ["@cbxss/tack-core", "@cbxss/tack-sources", "@cbxss/tack-generator"]) selectLegacy(name);
  assert.ok(!legacyDependencies["@cbxss/tack-sdk"]);
  await writeFile(join(legacy, "package.json"), JSON.stringify({
    private: true, type: "module", dependencies: legacyDependencies,
    devDependencies: { typescript: "7.0.2", "typescript-5": "npm:typescript@5.9.3", "@types/node": "22.20.2" }
  }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], legacy);
  await assert.rejects(lstat(join(legacy, "node_modules/@cbxss/tack-sdk")), { code: "ENOENT" });
  await cp(join(testDir, "consumer/fixture.mjs"), join(legacy, "fixture.mjs"));
  await writeFile(join(legacy, "generate.mjs"), `
import { discoverManifest } from "@cbxss/tack-sources";
import { generateSdkPromise } from "@cbxss/tack-generator";
const manifest = await discoverManifest({ servers: { kibana: { transport: "module", entry: "./fixture.mjs" } } });
await generateSdkPromise({ manifest, outDir: "./generated" });
await generateSdkPromise({ manifest, outDir: "./generated" });
`);
  run(process.execPath, ["generate.mjs"], legacy);
  await assert.rejects(lstat(join(legacy, "generated/sdk")), { code: "ENOENT" });
  await writeFile(join(legacy, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: false, noEmit: true, types: ["node"] },
    include: ["generated/**/*.ts"]
  }));
  for (const compiler of ["typescript", "typescript-5"]) {
    run(process.execPath, [join("node_modules", compiler, "bin", "tsc"), "-p", "tsconfig.json"], legacy);
    console.log(`Legacy core/sources-only consumer: ${compiler}, recursive generated/**/*.ts passed without SDK`);
  }
  await cp(join(testDir, "consumer"), consumer, { recursive: true });
  await writeFile(join(consumer, "tack.config.json"), JSON.stringify({ servers: { kibana: { transport: "module", entry: "./fixture.mjs" } } }));
  const compilerOptions = {
    target: "ES2022", lib: ["ES2022", "ESNext.Disposable"], types: ["node"],
    module: "NodeNext", moduleResolution: "NodeNext", strict: true,
    exactOptionalPropertyTypes: true, skipLibCheck: false, declaration: true, rootDir: "."
  };
  await writeFile(join(consumer, "tsconfig.typed.json"), JSON.stringify({
    compilerOptions: { ...compilerOptions, noUncheckedIndexedAccess: true, outDir: "dist-typed" },
    files: ["typed.ts"]
  }, null, 2));
  await writeFile(join(consumer, "generate.mjs"), `
import { loadConfigPromise } from "@cbxss/tack-core";
import { discoverManifest, SOURCE_KINDS } from "@cbxss/tack-sources";
import { generateProjectTypesPromise } from "@cbxss/tack-generator";
import { includeProjectDeclaration } from "@cbxss/tack-typecheck";
import { writeFile } from "node:fs/promises";
const config = await loadConfigPromise("./tack.config.json", SOURCE_KINDS);
const primary = await generateProjectTypesPromise({ manifest: await discoverManifest(config), projectDir: ".", configPath: "./tack.config.json" });
const otherConfig = { servers: { secondary: config.servers.kibana } };
await writeFile("other.config.json", JSON.stringify(otherConfig));
const secondary = await generateProjectTypesPromise({ manifest: await discoverManifest(otherConfig), projectDir: ".", configPath: "./other.config.json" });
for (const declaration of [primary, secondary]) await includeProjectDeclaration("./tsconfig.typed.json", declaration);
await writeFile("declarations.json", JSON.stringify([primary, secondary]));
`);
  run(process.execPath, ["generate.mjs"]);
  const declarations = (await json(join(consumer, "declarations.json"))).map(path => relative(consumer, path));
  assert.deepEqual((await json(join(consumer, "tsconfig.typed.json"))).files, ["typed.ts", ...declarations]);
  // This separate project deliberately receives no declarations.
  await writeFile(join(consumer, "tsconfig.dynamic.json"), JSON.stringify({
    compilerOptions: { ...compilerOptions, outDir: "dist-dynamic" }, files: ["dynamic.ts"]
  }, null, 2));
  for (const mode of ["dynamic", "typed"]) {
    for (const compiler of ["typescript", "typescript-5"]) {
      run(process.execPath, [join("node_modules", compiler, "bin", "tsc"), "-p", `tsconfig.${mode}.json`]);
      console.log(`${mode} consumer: ${compiler}, strict + skipLibCheck:false passed`);
    }
  }
  await writeFile(join(consumer, "run.mjs"), `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
const base = pathToFileURL(process.cwd() + "/").href;
let sdkLoaded = false;
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  assert.ok(!/node_modules\\/(?:@cbxss\\/(?:tack|tack-agent|tack-service|tack-generator|tack-typecheck|tack-runtime-quickjs|tack-runtime-workerd)|quickjs-emscripten(?:-core)?|workerd)\\//u.test(result.url), result.url);
  if (result.url.startsWith("file:")) assert.ok(result.url.startsWith(base), "import escaped clean consumer: " + result.url);
  if (result.url.includes("/@cbxss/tack-sdk/")) sdkLoaded = true;
  return result;
} });
const { runDynamic } = await import("./dist-dynamic/dynamic.js");
const { runTyped } = await import("./dist-typed/typed.js");
await runDynamic();
await runTyped();
assert.ok(sdkLoaded);
console.log("Packed direct-import dynamic + project-typed fixture calls passed; no forbidden imports or workspace links");
`);
  console.log(run(process.execPath, ["run.mjs"]).trim());
  const examples = join(consumer, "examples");
  await cp(join(consumer, "node_modules/@cbxss/tack-sdk/examples"), examples, { recursive: true });
  // Start like npm init: no inherited ESM package mode, no tsconfig, no preseeded
  // compiler options. Use the built CLI as globally installed setup tooling;
  // all fixture/app imports still resolve to the isolated packed dependencies.
  await writeFile(join(examples, "package.json"), JSON.stringify({ private: true }));
  await assert.rejects(lstat(join(examples, "tsconfig.json")), { code: "ENOENT" });
  const cli = join(root, "packages/cli/dist/index.js");
  run(process.execPath, [cli, "init", "--sdk"], examples);
  run(process.execPath, [cli, "build"], examples);
  const createdConfig = await readFile(join(examples, "tsconfig.json"), "utf8");
  for (const compiler of ["typescript", "typescript-5"]) {
    const diagnostics = run(process.execPath, [join(consumer, "node_modules", compiler, "bin/tsc"), "-p", "tsconfig.json", "--noEmit"], examples, true);
    assert.match(diagnostics, /TS1309/u); // documented .ts examples need ESM
    assert.match(diagnostics, /TS1470/u);
  }
  // Apply the explicit documentation step, not a hidden fixture prerequisite.
  assert.match(await readFile(join(consumer, "node_modules/@cbxss/tack-sdk/README.md"), "utf8"), /npm pkg set type=module/u);
  run("npm", ["pkg", "set", "type=module"], examples);
  // The documented .mts alternative must select the source fixture before any
  // JavaScript has been emitted, not only work after a prior compilation.
  await cp(join(examples, "inline.ts"), join(examples, "inline.mts"));
  await assert.rejects(lstat(join(examples, "tools.js")), { code: "ENOENT" });
  assert.match(run(process.execPath, ["inline.mts"], examples), /Inline config/u);
  await writeFile(join(examples, "typed.mts"), `
import { Tack } from "@cbxss/tack-sdk";
const tack = new Tack({ configPath: "./tack.config.json" });
try {
  const value: string = (await tack.tools.local.echo({ message: "MTS project types" })).data;
  console.log(value);
} finally { await tack.close(); }
`);
  for (const extension of ["mts", "cts"]) {
    await writeFile(join(examples, `bad.${extension}`), 'const invalid: number = "wrong"; export {};');
  }
  for (const compiler of ["typescript", "typescript-5"]) {
    const diagnostics = run(process.execPath, [join(consumer, "node_modules", compiler, "bin/tsc"), "-p", "tsconfig.json", "--noEmit"], examples, true);
    assert.match(diagnostics, /bad\.mts\(1,7\): error TS2322/u);
    assert.match(diagnostics, /bad\.cts\(1,7\): error TS2322/u);
    assert.equal((diagnostics.match(/error TS\d+/gu) ?? []).length, 2, diagnostics);
  }
  for (const extension of ["mts", "cts"]) await rm(join(examples, `bad.${extension}`));
  for (const compiler of ["typescript", "typescript-5"]) {
    run(process.execPath, [join(consumer, "node_modules", compiler, "bin/tsc"), "-p", "tsconfig.json", "--outDir", "dist"], examples);
    assert.match(run(process.execPath, ["dist/dynamic.js"], examples), /Hello from Tack/u);
    assert.match(run(process.execPath, ["dist/inline.js"], examples), /Inline config/u);
    assert.match(run(process.execPath, ["dist/inline.mjs"], examples), /Inline config/u);
    assert.match(run(process.execPath, ["dist/typed.mjs"], examples), /MTS project types/u);
  }
  assert.match(run(process.execPath, ["dynamic.ts"], examples), /Hello from Tack/u);
  assert.match(run(process.execPath, ["inline.ts"], examples), /Inline config/u);
  assert.match(run(process.execPath, ["typed.mts"], examples), /MTS project types/u);
  assert.equal(await readFile(join(examples, "tsconfig.json"), "utf8"), createdConfig);
  console.log("Packed first-run CLI setup: untouched tsconfig, ESM documentation, TS5/7 Node types, .mts/.cts diagnostics, and native/compiled scripts passed");
  console.log(`Packed ${selected.size} local packages; SDK runtime closure: ${runtimePackages.join(", ")}`);
  console.log(`Host ${process.version}; consumer removed on completion`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
