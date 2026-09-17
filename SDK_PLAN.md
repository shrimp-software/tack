# Tack SDK implementation

Status: implemented and validated for the 2.2.0 release. The direct-import/project-
declarations revision replaces the earlier generated-client design. The user has
authorized the coordinated version bump, commit, push, and npm publication.

## Settled public API

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

This executes without generation. Tool-specific compile-time checking is enabled
by project declarations without changing this import or supplying `<TackTools>`.

## Completed

- [x] Direct-import `@cbxss/tack-sdk`, sharing the existing hostless invoker,
  operation graph, input validation, policies, auditing, and source implementations.
- [x] Lazy single-flight initialization, config snapshots and config-relative
  source paths; transport reuse; discovery helpers; canonical `call` fallback.
- [x] `.data` success envelopes and structured `TackError` failures. Output
  validation remains advisory. No automatic retries or outgoing query rewriting.
- [x] Per-caller deadlines cover initialization and execution, cancellation is
  isolated during shared initialization, and close/disposal are idempotent.
- [x] Discovery results are deep-copied: callers cannot mutate the cached operation
  graph, validation schemas or discriminator injections through search/describe.
- [x] Safe null-prototype tool proxies, including matching blocked-prototype
  typings on namespaces and callable leaves. Reflection-sensitive paths remain
  available through canonical `call`.
- [x] Removed the new `generate --live` option, `liveClient` generator option,
  generated runtime client, alternate SDK imports, and public `TackClient` seam.
- [x] Added config-bound `TackConfigRegistry` declarations. Constructor options
  infer a registered literal path's tree; default construction uses the default
  config binding, if present. Inline, widened-string, unknown paths and supplied
  empty/erased options remain dynamic. No-argument/default-undefined construction
  is distinguished from supplied options; required config generics require runtime
  arguments. Multiple known configs do not merge their tool trees.
- [x] Public instance compatibility depends on the selected tool tree rather than
  constructor-option identity. Plain `Tack` variables, collections and factory
  returns accept dynamic clients; project-bound annotations still reject other
  catalogs and erased configs. The public constructor retains literal inference
  and required-option safety, with the same runtime class and subclass behavior.
- [x] Constructor selectors must be own data properties. Accessor/inherited
  selectors and non-object options fail with `invalid_options`, without running
  getters or silently selecting a default config.
- [x] `tack init --sdk` enables `{ "sdk": { "tsconfig": "./tsconfig.json" } }`
  while preserving existing servers/settings. Optional `--tsconfig` is relative
  to the Tack config; repeating setup preserves a selected custom tsconfig.
- [x] SDK-enabled `tack build` refreshes live discovery and writes declarations
  under `.tack/types/`, then includes them in the selected TypeScript project.
  Runtime construction never writes files or starts type generation.
- [x] Declaration generation reuses schema compilation, operation naming and
  method-tree rendering. No code-mode globals or generated JavaScript are emitted.
  Different configs own separate stable declaration files; refresh preserves
  other catalogs and manual files. Symlinked child targets/manual files are
  rejected; trusted symlinked project roots are supported.
- [x] Project inclusion preserves compiler options, JSONC comments, source globs,
  inherited files and their relative paths. Minimal projects are created when
  absent, with explicit Node types and inclusion of `.mts`/`.cts`/`.tsx` as well
  as `.ts`. Existing compiler type selections are preserved. Malformed configs,
  duplicate file lists, symlink targets and
  references-only solution configs fail with actionable errors.
- [x] Legacy static `tack generate` and non-SDK `tack build` remain SDK-independent.
  The legacy generator renderer/file writer are unchanged from the released base.
- [x] Direct-import docs explicitly explain ESM for compiled `.ts` scripts and
  `.mts` as an alternative in CommonJS projects. Fixture scripts support native
  and compiled execution, including emitted module paths in the inline example.
  A renamed native `inline.mts` is tested before emission, and its compiled `.mjs`
  counterpart is executed under both supported compiler versions.
- [x] Isolated packed consumers now exercise real CLI setup with no existing
  tsconfig, not preseeded compiler options. They prove the documented ESM step,
  fresh TS7 Node type inclusion, and diagnostics in `.mts`/`.cts` sources.
- [x] Agent test/typecheck task overrides retain `^build` dependencies, preventing
  a race with QuickJS's clean rebuild. Sources typechecking also waits for its own
  build because its example self-imports the package's emitted declarations. Both
  ordering requirements are checked against the task graph.

## Validation

Parent executed:

- `bunx turbo run build --force`
- `bunx turbo run typecheck --force`
- `bunx turbo run test --force`: **537 tests pass**, no test-cache reuse.
- Packed consumer matrix: Node **22.18.0 / 24.18.0**, TypeScript **5.9.3 / 7.0.2**.
  Both dynamic and project-typed scripts import the npm-packed SDK directly;
  strict checking and `skipLibCheck: false` pass. Project-bound consumers also use
  `noUncheckedIndexedAccess: true`.
- Positive/negative compiler contracts cover argument/output schemas, required
  inputs, call options, extracted methods, blocked prototypes, multiple configs,
  default config aliases, erased options, omitted required constructor arguments,
  optional config unions, plain instance annotations, config-bound subclasses,
  and dynamic fallback without type/global leakage.
- Packed setup tests use the built CLI's `init --sdk` and `build` against an
  untouched first-run project. No handwritten alternate client or preseeded
  tsconfig masks setup failures. App runtime guards reject CLI, agent, service,
  generator, typecheck and sandbox imports. Workspace links are forbidden.
- Legacy packed consumers recursively compile generated output without the live
  SDK installed. Documentation fixture scripts execute directly and compiled.
- CLI tests exercise SDK enablement, repeated builds, custom config-relative
  TypeScript projects, preservation of existing configs, and legacy defaults.

Independent adversarial, senior-engineer and prospective-user review, followed by
adjudication, found five issues in project typing/setup. The parent reproduced
those failures in packed consumers, added failing regressions, then fixed all
five: catalog-binding soundness, accessor/inherited selector routing, source
extension inclusion, fresh TS7 Node types, and the ESM documentation prerequisite.
A follow-up three-perspective review plus independent verification confirmed all
five corrections and found two P2 usability regressions: plain `Tack` annotations
rejected dynamic clients, and the renamed native `.mts` inline example selected
nonexistent JavaScript. The parent reproduced both against freshly packed code,
added failing regression coverage, and fixed them while preserving constructor
soundness. The latest fixes pass the validation above; they have not received a
new independent clean review.

## Explicit boundaries

- Declarations must be included in the actual script project. A loose script,
  `tsc script.ts`, or a referenced child project does not implicitly inherit them.
- Bindings are project-relative config-path literals. Run scripts from that
  project directory. Arbitrary/absolute strings and inline configs stay dynamic.
  Configs must reside within the chosen TypeScript project's directory tree.
- Schemas are snapshots, not promises about a live server's behavior. Rebuild
  after changes; missing output schemas remain `unknown`. No runtime output gate.
- Removing a server and rebuilding replaces its config's declaration. Removing a
  whole config binding requires removing its tsconfig `files` entry and declaration;
  removing `sdk` stops refreshes but does not silently rewrite project bindings.
- No background watcher, language-server plugin, automatic registration command,
  global type cache or node_modules modification was introduced.
- Live server compatibility depends on the configured server. Validation uses
  fixtures, never the user's production MCP servers.
- Local handlers must cooperate with cancellation. Cancelling an already-dispatched
  stdio request may retire its shared connection; close waits for discovery cleanup.
- Node 22.18+ is the supported host. Bun is used for workspace development, not a
  promised SDK execution host. Browser, resume and paused-approval flows are out
  of scope.

Release 2.2.0 synchronizes all 17 workspace packages and their internal dependency
pins, including the new `@cbxss/tack-sdk`. Release authorization was provided after
the validation and review-fix work above.
