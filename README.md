# Tack

Tack turns live sources — MCP servers, local TypeScript modules, and plugin bundles — into agent-friendly TypeScript tools. It discovers tools, infers stable operation paths, generates a typed SDK, and exposes one `execute` tool over MCP.

Tack 2 requires Node 22.18+ for its execution host; Node 24 is the reference runtime. Bun remains supported for installing and building the workspace.

The SDK target is TypeScript only. Code mode runs on QuickJS by default, with workerd available as an optional runtime. The live SDK calls tools directly without either sandbox.

## Use tools from a script

```sh
npm install @cbxss/tack-sdk
```

```ts
import { Tack } from "@cbxss/tack-sdk";

const tack = new Tack({ configPath: "./tack.config.json" });
try {
  const result = await tack.tools.kibana.kubelogs.search({
    namespace: "xservice", query: "level:error"
  });
  console.log(result.data);
} finally {
  await tack.close();
}
```

Paths and schemas come from your configured tools; the example is not a built-in
Kibana API. Calls initialize lazily, return `.data`, and throw `TackError` on
failure. Direct imports work without setup; paths and inputs are checked at runtime.
For tool-specific autocomplete and compile-time checks, enable project declarations
once, then refresh them when your configured servers change. Compiled `.ts` scripts
need an ESM project (`"type": "module"`); use `.mts` in an existing CommonJS project.

```sh
npm install -D typescript @types/node
npm pkg set type=module  # for .ts scripts; omit if using .mts in a CommonJS project
npx @cbxss/tack init --sdk  # also works with an existing Tack config
npx @cbxss/tack build
```

Keep the exact same SDK import and constructor. Build includes config-bound
`.d.ts` files in your TypeScript project; no generated-client import or explicit
user generic is needed. Loose scripts without those declarations remain dynamic,
and outputs without a server schema remain `unknown`.

See the [SDK guide and runnable local examples](packages/sdk/README.md) for inline
config, cancellation, errors, project setup, and reliable cleanup. The legacy
static `createTackClient` SDK and code-mode APIs remain available unchanged.

## Packages

| Package | Purpose |
| --- | --- |
| `@cbxss/tack-core` | Config, manifests, operation planning, shared safe-data helpers |
| `@cbxss/tack-mcp` | MCP discovery and invocation |
| `@cbxss/tack-sources` | Source dispatch (MCP, module, and plugin sources), `defineTool` authoring API |
| `@cbxss/tack-plugin` | Plugin-bundle discovery, git fetching, lockfiles, skills, and bundled MCP servers |
| `@cbxss/tack-generator` | TypeScript SDK and docs generation |
| `@cbxss/tack-sdk-types` | Schema compilation and typed SDK declaration generation |
| `@cbxss/tack-sdk` | Direct-import live client, with config-bound project types |
| `@cbxss/tack-typecheck` | Type checking for code-mode programs |
| `@cbxss/tack-codemode` | Search, describe, execution engine, runtime helpers |
| `@cbxss/tack-runtime-quickjs` | Default isolated runtime |
| `@cbxss/tack-runtime-workerd` | Optional process-isolated runtime |
| `@cbxss/tack-host-jobs` | Bounded worker jobs and SQLite coordination |
| `@cbxss/tack-validation` | Runtime JSON Schema validation |
| `@cbxss/tack-responses` | Durable response storage, paging, scans and quotas |
| `@cbxss/tack-agent` | Agent-facing MCP server |
| `@cbxss/tack-service` | Authenticated HTTP service |
| `@cbxss/tack` | CLI entrypoint |

## Development

```sh
bun install
bun run build
bun run typecheck
bun run test
bun run --cwd packages/sdk test:consumer # isolated npm-packed SDK + project-types smoke
```

CLI:

```sh
bun run --cwd packages/cli dev -- --help
```

## Usage

Install the CLI globally, or run it without installing:

```sh
npm install -g @cbxss/tack
npx -y @cbxss/tack --help
```

```sh
bun run --cwd packages/cli dev -- init
bun run --cwd packages/cli dev -- inspect
bun run --cwd packages/cli dev -- doctor
bun run --cwd packages/cli dev -- generate
bun run --cwd packages/cli dev -- docs
bun run --cwd packages/cli dev -- build
bun run --cwd packages/cli dev -- call <operation.path> --json '{}'
bun run --cwd packages/cli dev -- execute --file probe.ts
bun run --cwd packages/cli dev -- skill install
bun run --cwd packages/cli dev -- plugins add github:owner/plugin --ref v1.0.0
bun run --cwd packages/cli dev -- plugins list
bun run --cwd packages/cli dev -- mcp
bun run --cwd packages/cli dev -- host --host 127.0.0.1 --port 8788
bun run --cwd packages/cli dev -- serve
```

`mcp` serves local stdio MCP. `host` serves MCP Streamable HTTP at `/mcp`; omit `service.users` for open MCP or add users for bearer auth. `serve` requires `service.users`. Generated SDK output defaults to `.tack/generated`.

Minimal config:

```json
{
  "servers": {
    "grafana": {
      "transport": "stdio",
      "command": "uvx",
      "args": ["mcp-grafana"],
      "env": {
        "GRAFANA_URL": "http://localhost:3000",
        "GRAFANA_SERVICE_ACCOUNT_TOKEN": "..."
      }
    }
  },
  "runtime": {
    "type": "quickjs"
  },
  "service": {
    "users": [
      {
        "id": "user-1",
        "token": "..."
      }
    ]
  }
}
```

Use `"runtime": { "type": "workerd" }` to switch code-mode execution to workerd. Operation paths are inferred from MCP tool names and discriminator schemas.
The `service` block is only needed for bearer-protected `host` or for `serve`.

Set `"runtime": { "normalizeWhitespace": ["grafana"] }` to strip incidental
whitespace junk (padded lines, runs of blank lines, doubled spaces) from every
string in a downstream response's `.data`, for just the listed server ids,
before it reaches the sandbox. It's per-source and off by default — leave out
any server whose responses are code, diffs, or markdown, where indentation
and blank lines carry meaning (the bundled `markdown-source.ts` example is
one: normalizing it would mangle fenced code blocks in the skills it serves).

## Sources

The MCP surface is `execute({code,typecheck?:"strict"|"off"})`. Every cell starts
fresh on both HTTP and stdio. Semantic checking is opt-in; runtime input validation
always runs before downstream calls, without coercion.

```ts
// Search items carry `inputSchema` and a copy-paste `example` — call directly,
// no `tools.describe.tool` round trip. TypeScript signatures are behind `types: true`.
const { items } = await tools.search({ query: "list datasources" });
const list = await tools.call(items[0].path, {});
if (!list.ok) throw new Error(list.error.message);
const result = await tools.grafana.queryPrometheus({
  datasourceUid: list.data[0].uid, // resolve ids from a list call, never guess
  expr: 'up{service="feed-api"}',
  endTime: "now",
});
if (!result.ok) return result.error;
// `result.data` is the whole downstream value, in the sandbox. Shape it here.
return result.data.result.slice(0, 5);
```

A successful downstream call returns `{ ok: true, data, responseId, dataShape }`
— `data` is the full value, delivered into the sandbox to process in code. A
failed call returns `{ ok: false, error: { code, message } }` and identifies
whether the upstream call succeeded, failed, did not start, or has an unknown
outcome; never automatically replay a write.

`data` is not visible to the model until a cell returns it. `dataShape` — always
present on a successful result — is a compact type-only skeleton of `data`
(`{ result: { array: 240, of: "object{metric,values}" } }`), so the model can
see the layout before writing `data.x.y` paths without a round trip. `shape(value,
maxDepth?)`, a synchronous helper in every cell, is the same skeleton on demand,
deeper by default.

A downstream response larger than the sandbox limit (default 10 MiB) rejects with
`error.code "response_too_large"` — recover by narrowing the upstream query (a
smaller time window, an added filter) and retrying. The model-facing structured
result is capped at 16 KiB (32 KiB on the MCP wire including its text copy); a
returned value over that comes back with `resultTruncated: true`, keeping
structure: an array's leading whole elements plus `{ shown, total }`, an object's
leading keys' whole values plus `{ shownKeys, totalKeys, omitted }`, or a
readable string head for a scalar. Summarize in code rather than returning raw
payloads.

Every execution is recorded to an internal audit store under `storage.root`
(default `.tack/state` beside the config); it is not reachable from sandbox code.
Authenticated HTTP uses stable user IDs; open HTTP uses temporary shared storage.
Direct embedders supply an `ExecutionHost({root})` and close it when finished.

See [migration details](MIGRATION.md) for the breaking API and generated type changes.
The direct static SDK still exposes `TackResult.raw`, `text()` and `json()`; it is a
host client API, separate from sandbox code-mode delivery.

Every `servers` entry is a **source**. Tack supports these source types:

- `stdio` / `http` — an MCP server, discovered live.
- `module` — a local TypeScript file that exports tools. `entry` is resolved relative to the config file.
- `plugin` — a plugin bundle, normally created from the top-level `plugins` block rather than written directly.

```json
{
  "servers": {
    "grafana": { "transport": "stdio", "command": "uvx", "args": ["mcp-grafana"] },
    "local": { "transport": "module", "entry": "./tack/local.ts" }
  }
}
```

A module source exports one `defineTool()` per tool. Each has a `name` (its stable identity); a Zod `input` schema is validated on every call and converted to JSON Schema for discovery (a plain JSON Schema object is also accepted and used as-is).

```ts
import { z } from "zod";
import { defineTool } from "@cbxss/tack-sources";

export const searchDocs = defineTool({
  name: "search_docs",
  description: "Full-text search over internal docs",
  input: z.object({ query: z.string(), limit: z.number().default(10) }),
  async handler({ query, limit }) {
    const res = await fetch(`https://docs.internal/api?q=${query}&n=${limit}`);
    return res.json();
  }
});
```

Module sources run in the host process with full authority — unlike code mode, they are not sandboxed. They are trusted code, on the same footing as the config itself; agent calls into them still pass through `security.allowedOperations` and the audit log. A handler that throws (or fails input validation) surfaces as an error result, not a crash. Wrapping a command-line tool is just a handler that spawns it.

Running `.ts` entries needs a TypeScript-aware runtime: `tack` under `tsx`, or Node 22.18+ with type stripping. `.js` / `.mjs` entries work everywhere.

A worked example lives at `packages/sources/examples/markdown-source.ts` (serve a folder of markdown files as `list` / `read` tools); `packages/agent/test/module-source.e2e.test.ts` registers it and drives it end-to-end over MCP.

## Plugins

Plugins are mounted under one namespace and can contribute skills plus bundled MCP servers. Add a local plugin or a git-pinned plugin with the CLI:

```sh
tack plugins add ./my-plugin
tack plugins add github:owner/plugin --ref v1.0.0 --as acme
tack plugins update
```

This writes a top-level `plugins` block to `tack.config.json`. Git plugins are resolved to a commit, cached under `.tack/plugins/`, and recorded in `tack.plugins.lock`; local plugins are used from their configured path. A plugin directory contains `.claude-plugin/plugin.json`, with optional `skills/<name>/SKILL.md` files and an optional `.mcp.json` containing `mcpServers`.

## Notes

- Generated SDK files are marked `/* Generated by Tack. Do not edit directly. */`.
- The generator refuses to overwrite non-generated `.ts` files. `tack generate` and non-SDK `tack build` retain the legacy static API without requiring the live SDK. SDK-enabled projects use `tack build` to refresh project declarations instead.
- MCP `execute` keeps a short dynamic description; call `tools.guidance.read({name:"execute"})` inside a cell for more detail.
- Code mode provides `tools.search`, `tools.describe.tool`, `tools.call`, inferred `tools.<path>` methods, `emit`, and `shape`. Every successful downstream result carries a `dataShape` type skeleton.
- Cells are fresh across transports — no variables, refs or saved-response reads persist across calls. Live tool-call traces stream as `notifications/progress`.
- Evals live in `evals/`; Kibana setup lives in `evals/kibana/`.
- `repos/` is read-only reference material and must not be imported.
