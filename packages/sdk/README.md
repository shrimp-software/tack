# @cbxss/tack-sdk

Call configured MCP, module, and plugin tools from a normal Node TypeScript script.
No Tack service, sandbox, or generation is required to execute tools.

```sh
npm install @cbxss/tack-sdk
```

```ts
import { Tack } from "@cbxss/tack-sdk";

const tack = new Tack({ configPath: "./tack.config.json" });
try {
  const result = await tack.tools.kibana.kubelogs.search({
    namespace: "xservice",
    query: "level:error"
  });
  console.log(result.data);
} finally {
  await tack.close();
}
```

Paths and arguments above come from your configured tools, not a built-in Kibana
API. Node **22.18+** is required; Node 24 is the reference runtime. For
Node-compatible TypeScript, run `node script.ts` or compile with
`module: "NodeNext"`. **The SDK is ESM-only.** Compiling these `.ts` examples requires
`"type": "module"` in your project's `package.json`. For a new ESM project, use
`npm pkg set type=module`. In an existing CommonJS project, use `.mts` scripts
(emitted as `.mjs`) instead of changing the whole package's module mode.
Native Node TypeScript syntax detection is different from TypeScript compilation;
it does not make CommonJS `require("@cbxss/tack-sdk")` supported.
Browser and Bun runtime support are not promised.

## Strong typing with the same import

Enable project declarations once, using the separately installed Tack CLI:

```sh
npm install -D typescript @types/node
npm pkg set type=module # for the .ts examples; use .mts instead in a CommonJS project
npx @cbxss/tack init --sdk
# Configure servers in tack.config.json, if not already configured.
npx @cbxss/tack build
```

`init --sdk` preserves an existing config's servers and adds:

```json
{ "sdk": { "tsconfig": "./tsconfig.json" } }
```

`build` discovers the configured servers, writes a schema snapshot under
`.tack/types/`, and explicitly includes its declaration file in the TypeScript
project. It preserves existing compiler options, comments, source inclusion, and
inherited settings. If necessary, it creates a minimal Node `tsconfig.json` with
`types: ["node"]` and source inclusion covering `.ts`, `.mts`, `.cts`, and `.tsx`.
Existing projects must already include the Node types their scripts need; build
never replaces their compiler type selections. It refuses to replace manual
declarations or follow symlinked declaration targets.

**Your script does not change.** Import `Tack` from `@cbxss/tack-sdk` as above;
there is no generated client to import and no `<TackTools>` parameter to supply.
Within that project, TypeScript checks known tool paths, required arguments,
argument types, and output types when the server provides an output schema.

Run `tack build` again after changing servers or their schemas. This is an explicit
network discovery step; importing or constructing `Tack` never generates files.
Generated types are a snapshot, not a guarantee that the live server still matches.
Input validation and policy checks remain live; advisory output-schema mismatches
never suppress a successful result. Missing output schemas produce `unknown`.

### Config and project boundaries

- Run scripts from the TypeScript project's directory. Config strings are still
  resolved relative to the construction-time working directory, not the script file.
- Literal config paths acquire only their own catalog. For a root config, both
  `"./tack.config.json"` and `"tack.config.json"` work; `new Tack()` uses this default.
- Other registered config files can coexist without merging their tool trees.
  Each must be inside the project's directory tree. Enable and build each using
  `--config`; use `init --sdk --tsconfig <path>` to select their shared project.
  The tsconfig setting resolves relative to each Tack config file.
- Arbitrary string variables, absolute paths, unregistered configs, inline configs,
  and supplied empty/erased options (`{}`) stay dynamic. Only absent options
  (`new Tack()` or `new Tack(undefined)`) select the default binding implicitly.
  Use a literal path (or a `const` preserving its literal type) for another binding.
- The compiler/editor must load the configured tsconfig. `tsc -p tsconfig.json`
  does; `tsc script.ts` bypasses it. A loose script outside the project can still
  run, but does not automatically inherit project declarations.
- For monorepos, select the tsconfig that actually owns the scripts. Project
  references do not propagate declaration inclusion into referenced projects.
- To disable a binding, remove its entry from the tsconfig's `files` list and
  delete the corresponding generated declaration. Removing `sdk` from Tack config
  stops future refreshes; it does not edit existing TypeScript bindings.

Without a loaded binding, paths are dynamic, inputs are object-shaped, and `.data`
is `unknown`. With `noUncheckedIndexedAccess`, dynamic segments require
narrowing/non-null assertions; registered paths have known properties instead.

Plain `Tack` annotations work for variables, collections, and factory returns.
They describe the default config's tool tree (dynamic when unbound); retain the
inferred instance type when working with a different registered catalog.

Legacy `tack generate` is unchanged: it emits the static `createTackClient` API
and code-mode declarations. `tack build` does the same in projects without the
`sdk` setting. Static-only consumers need no live SDK dependency. Don't include
legacy ambient `tools.d.ts` in a direct-SDK script project.

## Configuration and discovery

`new Tack()` uses `tack.config.json` in the construction-time working directory.
A config file's source entries, plugin paths, and stdio `cwd` resolve relative to
that file. Module `entry` strings are runtime paths, not TypeScript imports: when
compiling a module, point at its emitted `.js` file. The runnable inline example
handles native `.ts`/`.mts` and compiled `.js`/`.mjs` fixture paths. Alternatively, supply inline
config (dynamic typing):

```ts
const tack = new Tack({
  config: { servers: { local: { transport: "module", entry: "./tools.ts" } } },
  configDir: import.meta.dirname
});
try {
  await tack.ready(); // optional: first call otherwise initializes lazily
  const matches = await tack.search({ query: "echo" });
  const description = await tack.describe("local.echo");
  const result = await tack.call("local.echo", { message: "hello" });
} finally {
  await tack.close();
}
```

Do not combine `config` and `configPath`. Configuration selectors (`config`,
`configPath`, `configDir`) must be own data properties: accessors and inherited
selectors are rejected with `invalid_options`, never evaluated or silently ignored.
`configDir` defaults to the construction-time cwd. The client snapshots its config and catalog, shares
initialization between callers, and reuses transports. There is no automatic
refresh or retry; create another client after a config change or initialization
failure. Discovery uses temporary connections separate from invocation, so a
stdio server may start more than once per client.

Reflection-sensitive paths (such as `name`, `length`, `call`, `constructor`,
`then`, or `toJSON`) are not exposed through the dot tree. Use the canonical
path with `tack.call(path, args)` instead; it retains the same validation and policy
checks and deliberately returns unknown data. Find canonical paths with `search`.

## Results, errors, and cancellation

Successful calls return `{ ok: true, data, dataShape, upstreamOutcome: "succeeded",
responseId: null }`. Data uses structured content first, otherwise parsed JSON
text (including `null`), otherwise plain text. There is no durable response store
or sandbox truncation. Configured response whitespace normalization remains
opt-in; outgoing arguments are never rewritten.

```ts
import { Tack, TackError } from "@cbxss/tack-sdk";

const tack = new Tack({ configPath: "./tack.config.json" });
try {
  const result = await tack.call("kibana.kubelogs.search", { query: "error" }, {
    signal: AbortSignal.timeout(10_000),
    timeoutMs: 5_000
  });
  console.log(result.data);
} catch (error) {
  if (!(error instanceof TackError)) throw error;
  console.error(error.code, error.path, error.upstreamOutcome, error.message);
  // Never automatically replay a write with an unknown upstream outcome.
} finally {
  await tack.close();
}
```

Dot methods accept the same optional second argument. For an optional-input tool,
use `method(undefined, { timeoutMs: 5000 })`. A caller timeout covers its wait for
initialization plus execution without cancelling another caller's discovery.
`runtime.toolTimeoutMs` remains the default downstream timeout if no per-call
override is supplied. Timeouts must be integer milliseconds from 1 to 2147483647.
Search and describe also accept call options.

Invalid inputs, policy denials, unknown operations, upstream failures, cancellation,
and timeouts reject with `TackError`; `code`, `path`, `upstreamOutcome`, and an
available `cause` explain the failure. There are no automatic retries.

Always close your client. `close()` is idempotent, prevents new calls, cancels
active callers, and closes owned transports, including resources allocated during
initialization. Local handlers must cooperate with cancellation; close waits for
in-flight discovery. Cancelling an already-dispatched stdio request can retire its
shared connection and affect other active calls. There are no global signal
handlers. `[Symbol.asyncDispose]()` aliases `close()` for runtimes supporting
`await using`.

## Examples and package verification

See [`examples/`](./examples/) for a fixture-only config, module, and direct-import
scripts. Copy them into your project (outside `node_modules`) and install
`@cbxss/tack-sdk` plus `@cbxss/tack-sources` for module authoring:

```sh
node dynamic.ts
node inline.ts
# Optional project typing and compilation, using the same scripts:
npm install -D typescript @types/node
npm pkg set type=module
npx @cbxss/tack init --sdk
npx @cbxss/tack build
npx tsc -p tsconfig.json --noEmit
```

Repository maintainers can validate a clean tarball consumer without publishing:

```sh
bun run build
bun run --cwd packages/sdk test:consumer
```

This packs the SDK and its internal dependencies, installs them into a disposable
npm project without workspace links, checks strict TypeScript 5.9 and 7 consumers
with and without config bindings, and runs fixture calls with forbidden-import
guards. It also checks legacy generation without the live SDK. It needs registry
access for external dependencies. No live user MCP servers are contacted.
