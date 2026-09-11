# Tack 2 migration

Regenerate SDK declarations with `tack generate`. Start execution hosts with Node
22.18 or newer; Node 24 is the reference runtime. The CLI and all workspace packages
use major version 2. This checkout does not imply an npm publication.

| Tack 1 | Tack 2 |
| --- | --- |
| `execute`, `guide`, `deref`, optional sessions/delegate/search tools | One `execute({code,typecheck?:"strict"|"off"})` tool |
| Implicit persistent scope on some transports | Every cell runs fresh — no variables, refs or saved-response reads persist across calls |
| Default semantic errors/warnings | Semantic checking off by default; explicit strict requests fail closed if unavailable |
| `tools.responses.read/describe/scan`, `tools.executions.inspect` | Removed — downstream calls deliver `data` straight into the sandbox |
| `{ok:true,delivery:"inline",data}` / `{ok:true,delivery:"stored",response}` | `{ok:true,data,responseId}`; no `delivery` discriminator |
| Different empty-search namespace shape | Uniform `{ok,revision,items,total,hasMore,nextOffset,error?}` |
| Summary-only search requiring per-tool describes | Callable input signatures by default; `detail:"summary"` for compact listings |

## Removed surface

Gone: `tools.responses.read` / `tools.responses.describe` / `tools.responses.scan`,
`tools.executions.inspect`, the `inline`/`stored` delivery discriminator, big-value
refs (`$1`, `$_`, `deref`), stateful sessions and cross-cell scope, the
`session` / `fresh` / delegate calls, and the `maxInlineResultBytes` runtime option.
Additional properties on the execute request are still rejected.

Replace `typecheck.mode:"error"|"warn"` in config with `"strict"` (checker
available) or `"off"` (checker disabled). Config does not turn checking on for
every request. The CLI opt-in is `tack execute --typecheck strict`.

## Downstream calls

A successful call returns `{ ok: true, data, responseId, dataShape }` — `data` is
the whole downstream value, delivered into the sandbox. Filter, aggregate and
shape it in code; return a small summary. `dataShape` is a compact type-only
skeleton of `data` (`{ result: { array: 240, of: "object{metric,values}" } }`),
always present on success, so the model can see the layout before writing
property paths. A failed call returns `{ ok: false, error: { code, message } }`.
`ok:false` does not mean earlier calls were rolled back; `upstreamOutcome`
records what is known, and a write is never replayed automatically.

A downstream response larger than the sandbox limit (`maxToolResponseBytes`,
default 10 MiB) rejects with `error.code "response_too_large"`. Recover by
narrowing the upstream query — a smaller time window or an added filter — then
retry. There is no partial delivery.

## Discovery

`tools.search({query:""})` lists namespaces in `items`, each with
`kind:"namespace"`. Tool items have `kind:"tool"`, `path`, `description`, `params`
(required keys), the full `inputSchema`, and a copy-paste `example` — enough to
call the operation directly, so `tools.describe.tool` is not a required step
before a call (use it for the output schema or an ambiguous match). TypeScript
signatures (`inputTypeScript` / `outputTypeScript`) are behind `types:true` or
`detail:"full"`; `detail:"summary"` drops the schema for a compact listing. Pass
`namespace`, `offset`, `limit`, and the previous `revision` to continue; a stale
revision fails explicitly. Errors have `ok:false` and empty items — check `ok`
before acting on a page, and treat a thin or empty result as "search this
differently", not "the operation does not exist". An unusually large schema comes
back with the heavy fields dropped and `schemaTruncated:true`, keeping the path,
parameter names and example. The reserved roots are `call`, `search`, `describe`,
`guidance` and `then`; manifest generation renames collisions consistently.

## Execute result

An execute response is `{status,result?,resultTruncated?,receiptId?,responseId?,...}`.
Only bounded logs, emissions and at most three distinct diagnostics (2 KiB) are
inline. The model-facing structured result is capped at 16 KiB (32 KiB on the MCP
wire including its text copy); a returned value over that comes back with
`resultTruncated:true`, keeping structure — an array's leading whole elements
plus `{shown,total}`, an object's leading keys plus
`{shownKeys,totalKeys,omitted}`, or a readable string head for a scalar. There is
no retrieval path
and no automatic replay or approval resume. The JSON service uses this same
model-facing envelope.

Every cell also has `shape(value, maxDepth?)`: a synchronous, no-round-trip
type-only skeleton — the same view `dataShape` carries, deeper by default. Use it
to inspect a nested `data` layout further than `dataShape` shows, before writing
property paths.

## Storage

Every execution is recorded to an internal audit store under `storage.root`
(default `.tack/state` beside the config); it is not reachable from sandbox code.
CLI execution, stdio and authenticated HTTP use it; open HTTP shares a temporary
owner. Embedders share one `ExecutionHost` across connections and call
`host.close()` on shutdown; bare engines own a temporary host and need
`engine.close()`.

Bun's host Worker API does not provide the required memory-limit capability, so
execution fails closed under Bun. Bun can still install/build and launch
Node-based development scripts.
