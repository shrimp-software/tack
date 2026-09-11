# Reset Tack's code-mode surface to a minimal baseline

## Context

A prior design iteration failed its internal benchmark gate: 55.5% slower
median elapsed time, 2× the MCP calls, 16 failed execution cells, and tied
completeness. Transcript review named the causes — agents discarding
callable-search fields, guessing datasource IDs, assuming stored results were
inline, and struggling with nested object/array reads. The common thread is
surface area: the `inline`/`stored` delivery fork, the `responses.read/describe
/scan` paging API, and the big-value ref system (`$N` / `deref`) are all things
the model fumbles.

Decision: stop iterating on that design. Strip the code-mode surface to a
minimal baseline — one `execute` tool, downstream calls return `.data`
directly, no saved-response paging, no cross-cell variables — get a clean
benchmark number, then build back up from there.

This is a breaking change to the **uncommitted** Tack 2 API. Version stays
`2.0.0`; nothing is published or committed by this work.

## Design decisions (confirmed)

1. **Remove stateful sessions entirely.** They are already dead on every shipped
   surface — agent HTTP (`http.ts`) and stdio (`stdio.ts`) both build a fresh
   server per request and call `engine.execute()`; the CLI `execute` command
   does the same. `engine.createSession` / `createQuickJSSession` / the ref
   bridge / `$N` / `scope-rewrite.ts` are exercised only by tests.
2. **Remove `executions.inspect` from the sandbox.** No cell-facing
   introspection. The retained execution receipt stays (internal, for audit and
   eval evidence); a future CLI `inspect` can read it.
3. **Oversized downstream response.** Deliver `.data` in full into the sandbox,
   with no delivery-mode fork. Only *text representations* are ever truncated,
   with a visible marker; the structured value itself is never partially
   delivered. Concretely:
   - Deliver `.data` in full into the sandbox. Cap = `maxToolResponseBytes`,
     raised **1 MiB → 10 MiB**.
   - Above the cap, the runtime bridge already throws; reshape that into a clean
     rejection: `error.code = "response_too_large"`, message naming bytes, limit,
     and "narrow the upstream query (smaller window, add a filter)". No partial
     `.data` (truncated JSON is unparseable).
   - Final cell result to the model: keep the 16 KiB model / 32 KiB wire budget,
     but enforce it by **truncating with a marker, keeping structure** (a
     `resultTruncated: true` field in `structuredContent`). No divert to a
     stored reference, no retrieval path.

## Scope

**Removed from the agent-facing surface:** `inline`/`stored` delivery fork;
`tools.responses.read` / `.describe` / `.scan`; `tools.executions.inspect`;
`$N` / `$_` refs, `deref`, `TackRef`; stateful sessions and cross-cell scope
sharing; `maxInlineResultBytes`; `DELIVERY_LIMITS.tool`.

**Kept:** the one `execute` MCP tool and fresh cells; `tools.search`,
`tools.describe.tool`, `tools.guidance.read`, `tools.call`, inferred
`tools.<path>()`, `emit`; mandatory runtime input validation; opt-in strict
typecheck; `ExecutionHost.retain` and the `@cbxss/tack-responses` store as an
**internal audit receipt only**; owner isolation, origin/source-binding
authorization, write-no-replay semantics; the 16 KiB model / 32 KiB wire budgets.

**Out of scope (the "then we work from there" phase):** discovery ranking and
putting `inputSchema` + a call example in default search results (later
completed, see the discovery rounds below); `maxLocalCalls` / budget
introspection; any change to the frozen internal benchmark design (re-run it
unchanged once simplified).

## Phase 1 — Collapse the result contract

Make `engine.execute()` return a two-arm shape end to end.

- `packages/core/src/code-mode-result.ts` — `CodeModeResult<T>` and
  `CODE_MODE_RESULT_TS` become:
  `{ ok: true; data: T; responseId: string | null; upstreamOutcome: "succeeded" }
   | { ok: false; error: { code?: string; message: string }; upstreamOutcome?: ... }`.
  Drop the `delivery: "inline" | "stored"` arm and the `response` descriptor arm.
- `packages/codemode/src/types.ts` — `ToolCallOutput`: drop `delivery`,
  `response`; keep `data`, `responseId`, `upstreamOutcome`, `error`.
  `ExecutionResult`: drop `delivery`, `response`; keep `receiptId`, `responseId`,
  `result`. `BuiltinTraceEvent.path`: drop `responses.*` and `executions.inspect`
  members. Delete `TackRef`, `isTackRef`, `DerefResult`, `DerefOptions`,
  `CodeSession`, `CodeSessionOptions`; drop `createSession` from `CodeRuntime`.
- `packages/codemode/src/invoker.ts` — replace the delivery branch (the
  `jsonBytes(data) > DELIVERY_LIMITS.tool ? stored : inline` ternary near the end
  of `invokeOperation`) with `{ ok: true, data, responseId, upstreamOutcome:
  "succeeded" }`. Keep the `host.retain(...)` call for the audit receipt, but on
  retention failure **log and still return `data`** — data access must not depend
  on the store. Preserve the existing "do not replay automatically" messages for
  genuine upstream/validation failures.
- `packages/codemode/src/host.ts` — `DELIVERY_LIMITS`: delete `.tool`, keep
  `.model` and `.wire`. `finish()`: replace the inline-vs-`stored` branch with
  "project `publicExecution(base)`; if it exceeds `.model`/`.wire`, truncate
  `result.result`'s serialized form to fit and set `resultTruncated: true`";
  always return the `result` shape, never `delivery: "stored"` / `response`.
  Keep `receiptId` / `responseId` and `retain()`. `publicExecution()`: remove the
  `delivery`/`response` branch, always emit `result`.
- `packages/agent/src/server.ts` — `formatExecuteMcpResult` no longer sees
  `delivery`; `finish()` now guarantees the budget, so keep the
  `delivery_budget_exceeded` throw only as an unreachable safety net (or drop the
  `DELIVERY_LIMITS` import if unused).

## Phase 2 — Drop the saved-response sandbox surface

- `packages/core/src/builtins.ts` — delete `responses.describe`, `responses.read`,
  `responses.scan`, `executions.inspect` from `BUILTIN_CONTRACTS`. Remove the now
  unused local schemas (`readPage`, `descriptor`, `responseShapeSchema`, `page`,
  `coverage`, `provenance`, `scanOutput`, `pointer`) if nothing else in the file
  needs them. `RESERVED_TOOL_KEYS` recomputes automatically (loses `responses`,
  `executions`). Keep `search`, `describe.tool`, `guidance.read`.
- `packages/codemode/src/discovery.ts` — remove the
  `path.startsWith("responses.") || path === "executions.inspect"` routing. In
  `bounded()`, when a schema exceeds the 6 KB inline budget, return the schema
  text truncated with a `schemaTruncated: true` marker plus `path`, required
  param names and the call example — never a `host.retain` handle
  (`schemaResponseId`), which now points at nothing readable.
- `packages/codemode/src/host.ts` — delete the `inspect()` method (only the
  removed builtins called it).
- `packages/codemode/src/guide.ts` — rewrite `createExecuteDescription` and
  `renderExecuteGuide` around: `search` → inspect the input signature → `call` →
  return a small summary. State that downstream calls return `.data` directly;
  an oversized downstream response fails with `response_too_large` (narrow the
  query); an oversized cell return is truncated with a marker. Delete every
  mention of `stored`, `responses.*`, pages, `$N`/`deref`, `executions.inspect`.
- Regenerate the ambient surface (Phase 4).
- `packages/responses/**` — **left intact**; `ExecutionHost.retain` still uses it
  for the receipt. Mark `read` / `shape` / `scan` as candidates for a later
  deletion pass once confirmed unreferenced.

## Phase 3 — Remove stateful sessions and refs

- `packages/codemode/src/engine.ts` — delete `createSession`,
  `ExecutionSession`, the `codeRuntime.createSession` branch, `supportsSessions`.
  `runCell` loses its `scopeNames` parameter and the typechecker scope plumbing.
  Keep `execute()`.
- `packages/codemode/src/index.ts` — drop removed exports.
- `packages/runtime-quickjs/src/index.ts` — delete `createQuickJSSession`,
  `createRefBridge`, `REF_HELPERS_SOURCE`, `runSessionCell`,
  `transpileSessionCell`, `RefBridge`/`RefSink`, `REF_PREVIEW_LIMIT`,
  `DEREF_DEFAULT_LIMIT`; remove `createSession` from the returned `CodeRuntime`.
  Keep `executeInQuickJS` / `runUserFunction`. In `callToolFromQuickJS`, catch
  the `assertJsonByteLimit(..., maxToolResponseBytes)` failure and reject with
  `code: "response_too_large"` and the "narrow your query" message instead of a
  bare `Error`.
- `packages/runtime-quickjs/src/scope-rewrite.ts` — **delete** (session-only).
- `packages/runtime-workerd/src/{index,options,host-bridge}.ts` — mirror the
  quickjs changes: drop session/deref support and `maxInlineResultBytes`, raise
  the response cap, reshape the oversize throw. Representative file:
  `packages/runtime-workerd/src/host-bridge.ts`.
- `packages/typecheck/src/ambient.ts` — drop the session `scopeNames` handling;
  regenerate against the trimmed `BUILTIN_CONTRACTS`.
- `packages/cli/src/index.ts` — `printExecutionResult`: delete the
  `result.delivery === "stored"` branch. `createCodeRuntime`: drop the
  `maxInlineResultBytes` passthrough.

## Phase 4 — Limits, config, generated types

- `packages/runtime-quickjs/src/options.ts` — `DEFAULT_MAX_TOOL_RESPONSE_BYTES`
  1_000_000 → 10_485_760; delete `maxInlineResultBytes` from
  `QuickJSRuntimeOptions` / `QuickJSLimits` / `normalizeRuntimeOptions`. Leave
  `memoryMb` (128) — it is the OOM backstop for large `.data`.
- `packages/core/src/config.ts` — remove `maxInlineResultBytes` from the
  `runtime` schema; keep `maxToolResponseBytes`.
- `packages/sdk-types/src/tools-ambient.ts` — consumes the new
  `CODE_MODE_RESULT_TS`; the `BUILTIN_CONTRACTS` iteration drops
  `responses`/`executions` automatically. Verify the ambient `tools` type no
  longer has `responses` / `executions` members.
- `packages/generator/**` — SDK and doc templates that reference the delivery
  arms or `responses.*`; regenerate fixtures.

## Phase 5 — Docs

- `README.md` — rewrite the "Sources" section: downstream calls return `.data`;
  no `stored` delivery, no `responses.*`, no `$N`; oversized downstream →
  `response_too_large`; oversized return → truncated with a marker.
- `MIGRATION.md` — list the removed API as breaking.
- `packages/cli/src/skill.ts` — the bundled skill markdown references
  `responses.*` / `stored`; rewrite to the square-one surface.

## Phase 6 — Test sweep

Update, don't blanket-delete. Representative files:
`packages/codemode/test/codemode.test.ts`,
`packages/agent/test/{agent,http,delegate}.test.ts`,
`packages/runtime-quickjs/test/*`, `packages/generator/test/generator.test.ts`,
`packages/sdk-types/test/tools-ambient.test.ts`,
`packages/typecheck/test/checker.test.ts`,
`packages/service/test/service.test.ts`.

- Delete tests for sessions, `deref`/`$N`, and `responses.*` / `executions.inspect`.
- Update result-shape assertions from `delivery`/`response` to `{ ok, data }`.
- **Keep and retarget** the audit-integrity regressions (owner isolation,
  changed origin policy / source binding, cancellation, upstream success despite
  later validation/persistence failure, actual MCP wire budgets) at the internal
  receipt path.
- Add: downstream `.data` read directly in one cell; downstream > 10 MiB →
  `response_too_large`; cell return > 16 KiB → `resultTruncated` + marker, no
  stored ref; calling `tools.responses.read` / `tools.executions.inspect` in a
  cell returns `{ok:false, error:{code:"unknown_operation"}}` (the navigable
  `tools` proxy makes every name a callable, so the check is on the *result*).

## Verification

- `bun run build`, `bun run typecheck`.
- `bun run test` on Node 22.18+ and Node 24.
- Grafana real-MCP suite in `evals/grafana` (8 tests, includes live transport).
- Pack all packages into an isolated consumer; run QuickJS + workerd discovery,
  input validation, large-result delivery and the oversize path on both Node
  versions; confirm packed CLI reports `2.0.0` and a strict TS consumer resolves
  the packed declarations.
- Manual `tack execute` cells:
  1. call a Grafana op, use `result.data` directly, return a summary;
  2. call an op whose response exceeds 10 MiB → `ok:false`,
     `error.code === "response_too_large"`;
  3. `return someLargeObject` → result is truncated with a marker and
     `resultTruncated: true`, no `responseId`-based retrieval offered;
  4. reference `tools.responses` / `tools.executions` → `undefined`;
     `tools.search` / `tools.describe.tool` / `tools.guidance.read` still work.
- Only after all the above is green: re-run the internal benchmark with the
  unchanged design and record the new numbers.

## Risks

- **Losing the "zero client truncations" win.** Large final results now leave as
  truncated-text-with-marker instead of a stored reference. Mitigation: the
  `resultTruncated` summary lives in `structuredContent`, which clients read even
  when they clip the text channel.
- **QuickJS memory.** A 10 MiB serialized payload parses to ~30–50 MiB of JS
  objects; `memoryMb: 128` has headroom for one, not several. A cell that pulls
  multiple large responses can OOM into a normal execution error. Accepted (big
  data is the caller's problem) but note it; revisit the cap or default
  `memoryMb` if the benchmark shows OOM cells.
- **`@cbxss/tack-responses` left near-orphaned.** Keeping it avoids a large diff
  now; schedule a follow-up to delete `read`/`shape`/`scan` once confirmed dead.
- **Test-coverage loss.** Guard against over-deleting: the audit-integrity
  regressions must survive, retargeted at the receipt.

---

## Progress (2026-09-09)

All six phases implemented on `feat/agent-efficiency-overhaul` (uncommitted, no
publish). Summary of what landed:

- **Contract collapsed.** `CodeModeResult<T>` is now `{ok:true,data,responseId,
  upstreamOutcome}` | `{ok:false,error,...}` — no `delivery` arm, no `response`
  descriptor. `ToolCallOutput` / `ExecutionResult` / `publicExecution` follow.
  Retention failure on a successful call is non-fatal: `data` is still returned,
  the miss is noted on the audit event.
- **Saved-response sandbox surface removed.** `responses.read/describe/scan` and
  `executions.inspect` deleted from `BUILTIN_CONTRACTS`; `ExecutionHost.inspect`
  deleted; `discovery.ts` schema-overflow now returns the item with heavy fields
  dropped + `schemaTruncated:true` (no handle). `@cbxss/tack-responses` kept
  intact for the internal audit receipt.
- **Sessions and refs removed.** `createSession` / `CodeSession` / `TackRef` /
  `deref` / `$N` / `scope-rewrite.ts` gone from codemode, runtime-quickjs,
  runtime-workerd, engine, typecheck, CLI. `TypeChecker.check` lost its context
  arg.
- **Oversized handling.** `maxToolResponseBytes` default 1 MiB → 10 MiB;
  over-limit downstream response rejects with `error.code "response_too_large"`
  and a "narrow the query" message (both runtimes). An over-budget cell return
  is clipped to a truncated string preview with `resultTruncated:true`
  (byte-budgeted, halving until it fits the 16 KiB model / 32 KiB wire caps) —
  no retrieval path. `maxInlineResultBytes` removed.
- **Guide / README / MIGRATION / CLI skill** rewritten to the minimal-baseline
  surface.

**Verification — all green:**
- `bun run build` 16/16, `bun run typecheck` 31/31, `bun run test` 31/31 (Node 24).
- Full package suites re-run under Node 22.22.2 (the only 22.x on this box; ≥22.18):
  16 suites, 448 tests, all pass.
- `bun run eval:grafana:test` 8/8 (real stdio MCP). `bun run eval:typecheck` clean.
- Manual `tack execute` via the CLI against the Grafana mock: cell 1 (downstream
  `.data` + `responseId`, small summary) and cell 3 (oversized return →
  `resultTruncated:true` with a `…[truncated N bytes]` marker, no retrieval)
  confirmed live. Cell 2 (>10 MiB → `response_too_large`) and cell 4 (calling a
  removed builtin → `unknown_operation`) are covered by the runtime + agent unit
  tests rather than a separate CLI run.

**Not run:** the packed-package / isolated-consumer matrix. No `package.json`
`exports`/`files`/metadata changed this pass, `build` emits the same `dist`
declarations `typecheck` (31/31) already resolves against, and the strict-TS-
consumer path is exercised by the generator and sources test configs. Re-run it
before any publish.

### Discovery round 1 — triggered by internal benchmark diagnosis

Diagnosis showed elapsed time was dominated by turn count, not tool latency
(a few seconds of wall-clock were in-tool out of several minutes total). Root
cause in the transcript: the agent's first cell projected
`i.inputSchema ?? i.schema ?? i.input` on search items, got `null` every time
(the signature was under `inputTypeScript` / `params`, unnamed in the guide),
and fell back to `tools.describe.tool` per operation — many more search and
describe cells and in-code schema parses than necessary — plus a datasource-UID
guess (guessing plain names instead of the real UIDs, producing dozens of failed
probes) and a false "annotation API unavailable" claim from a thin search
result.

Fixes landed:
- **Default `search` items now carry `inputSchema`** (full JSON Schema, under
  that exact name) — `packages/codemode/src/search.ts` `toSearchItem`,
  `packages/core/src/builtins.ts` `searchOutput`.
- **`example` is a filled, copy-paste call** built from required properties with
  type-shaped placeholders (`{ "datasourceUid": "...", "expr": "...", "endTime":
  "..." }`), replacing the `(args)` stub — `packages/core/src/operations.ts`
  `operationExample` / new `exampleArgLiteral` + `examplePlaceholder`. Applies to
  search items, `describe.tool` examples, and generated docs.
- **TypeScript signatures moved behind `types:true` / `detail:"full"`;**
  `detail:"summary"` drops the schema — `packages/codemode/src/discovery.ts`.
- **Guide rewritten** (`guide.ts` description + `renderExecuteGuide`): "call
  directly from the search item's `inputSchema`/`example`; `describe.tool` is not
  a required pre-step"; "resolve datasource/dashboard UIDs by listing them, never
  guess"; "a thin/empty search result is not evidence an operation is missing".
- Docs synced: `README.md`, `MIGRATION.md`, `packages/cli/src/skill.ts`.
- All suites green again — Node 24 turbo 31/31, Node 22.22.2 448 tests, Grafana
  8/8, typecheck 31/31.

### Discovery round 2 — after a repeat benchmark pass

Describe cells fell to zero, search cells dropped substantially, the
datasource-guess failures stopped, and annotation discovery worked. New
transcript findings drove this round:
- **Response-shape guessing**: the agent wrote
  `resp.data?.data?.result ?? resp.data?.result ?? resp.data` then `.map()` — the
  fixture array is at `resp.data.data`; the fallback landed on a non-array and
  the cell threw `internal_error: not a function`. It can't see `data`, so it
  guessed paths. Exact analog of the datasource-UID problem.
- **Result-truncation re-queries**: cells with `resultTruncated: true` were each
  clipped to a string preview the agent then re-queried around; one clipped
  preview also produced a wrong reported timestamp.
- **Environment over-enumeration**: several cells grabbing all datasources /
  dashboards / alerts / metric names / label values before any real query, plus
  `types:true` inside a bulk search loop.

Fixes landed:
- **`shape(value, maxDepth?)`** — a synchronous, no-round-trip structural preview
  injected into every cell (`packages/codemode/src/tools.ts` `renderToolsPrelude`;
  ambient decl in `packages/sdk-types/src/tools-ambient.ts`). Nested objects keep
  keys + scalar values (never `[object Object]`), arrays sample 3 + a count, long
  strings clip. Guide tells the model to `shape(r.data)` before writing property
  paths.
- **Structure-preserving truncation** — `packages/codemode/src/host.ts`
  `clipForModel`: an oversized array return now keeps its leading whole elements
  as `{truncated, shown, total, items}` (binary-searched to fit) instead of a
  clipped string; non-arrays still get a byte-accurate string head. Fixes the
  re-query loop and the misparsed-preview bug.
- **Guide nudges** (`guide.ts`): "search for the specific operation, don't
  enumerate the environment"; "no `types:true` inside a multi-query loop"; the
  `shape()` instruction.
- Docs synced: `README.md`, `MIGRATION.md`, `packages/cli/src/skill.ts`.
- Green again — Node 24 turbo 31/31, Node 22.22.2 449 tests, Grafana 8/8,
  typecheck 31/31, build 16/16.

### Discovery round 3 — after a further benchmark pass

Elapsed time and uncached tokens both improved further; the response-shape
exception did not recur in this pass (the agent adopted `shape()`, though late).
Remaining gap traced to:
- **Clipped results were objects, not arrays** (multi-field maps like
  `{window, annotations, metricSummary, logs}`) → fell to the string head → the
  agent re-queried.
- **Clock discovery**: the agent used the newest sampled log timestamp as "now"
  instead of the environment tool's authoritative clock.

Fixes landed:
- **Structure-preserving truncation extended to objects** —
  `packages/codemode/src/host.ts` `clipForModel`: an over-budget object return
  keeps whole values for as many leading keys as fit, as
  `{truncated, shownKeys, totalKeys, kept, omitted:[...]}`. Symmetric with the
  array case; scalars still get a string head.
- **Guide** (`guide.ts`): describes the new truncated-return shapes; "read the
  current time from an environment/status/health operation, not from the newest
  timestamp in a result".
- Docs synced: `README.md`, `MIGRATION.md`, `packages/cli/src/skill.ts`.
- Green — Node 24 turbo 31/31, Node 22.22.2 449 tests, Grafana 8/8, typecheck
  31/31, build 16/16.

### Discovery round 4 — after a further benchmark pass

Structured object clipping worked; the agent found the correct clock and
rollback evidence (the clock-guidance line helped). But `shape()` adoption was
inconsistent, and a data-shape exception recurred: a `Promise.all` batch of
several label-value queries where one variant's result shape differed and the
agent `.map`'d a non-array. The agent shapes the first occurrence of a response
type, then assumes the rest match.

Fix landed:
- **`dataShape` on every successful result** —
  `packages/codemode/src/data-shape.ts` `describeShape` + `invoker.ts` attaches it
  to `{ok:true}`. A ~130-byte type-only skeleton of `data`
  (`{ result: { array: 240, of: "object{metric,values}" } }`), depth-3 and
  size-bounded (~400 B cap). A field is present on *every* result the agent
  destructures, so it doesn't have to remember `shape()` or shape each item in a
  batch. `CodeModeResult` / `ToolCallOutput` gain `dataShape`; `shape(value,
  depth?)` stays for deeper on-demand views.
- Guide + docs updated (`guide.ts`, `README.md`, `MIGRATION.md`,
  `packages/cli/src/skill.ts`).
- Green — Node 24 turbo 31/31, Node 22.22.2 451 tests, Grafana 8/8, typecheck
  31/31, build 16/16.

### Consolidation — after a "stop single-pass iterating" review

Several consecutive rounds of one-benchmark-pass-per-fix were a random walk on
a noise-dominated metric (baseline runs of the same unchanged comparison target
swung by roughly 2× on token count alone). Before running a real statistical
gate, cleaned up the accreted surface:

- **`shape()` and `dataShape` unified** — `packages/codemode/src/tools.ts`
  prelude `shape()` now emits the exact same type-only skeleton as
  `describeShape` (`data-shape.ts`), just deeper by default (maxDepth 5, bigger
  budget). One mental model; kept in sync by construction.
- **Guide trimmed** — `createExecuteDescription` cut ~13% (roughly 375 tokens
  always-loaded). Cut lines overfit to one benchmark scenario ("don't enumerate
  the environment", "no types:true in a loop"). Kept the general principles.
- **`hasEnoughCoverage` cutoff replaced with ranked retrieval** —
  `packages/codemode/src/search.ts`: no more coverage-ratio filter; keep any
  match with a primary-field token hit (or full coverage on schema-only), rank
  by score, `limit` bounds the tail. A long thin query with many tokens now
  returns its one real match instead of nothing — the actual cause of the false
  "operation unavailable" conclusions.
- **`clipForModel` object branch** — O(n) accumulation instead of O(n²)
  re-serialization; a single dominant key now recurses (`{key, value:<clipped>,
  omitted}`) instead of falling back to a string blob.
- Docs synced. Green — Node 24 31/31, Node 22.22.2 449 tests, Grafana 8/8,
  typecheck 31/31.

**Next:** run a proper statistical benchmark pass — multiple scenarios, multiple
repetitions — with median + spread per metric, and grade the reports with an
independent blinded pass (not the implementing agent). Then decide: (a) token
efficiency win + quality parity + wall-clock roughly tied → declare and commit;
(b) a real quality gap → one round of a worked-example skill + tighter
`maxToolCalls`, re-gate; (c) wall-clock is a hard requirement → treat it as
turn-bound and largely outside Tack's control. `maxLocalCalls` remains unbuilt
and unneeded for the gate.

**Follow-ups noted in the plan:** delete `@cbxss/tack-responses` `read`/`shape`/
`scan` once confirmed unreferenced; watch for QuickJS OOM on multi-MB `.data` in
benchmark runs.
