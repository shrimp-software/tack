# Tack

Tack turns live sources — MCP servers, local TypeScript modules, and plugin bundles — into agent-friendly TypeScript tools. It discovers tools, infers stable operation paths, generates a typed SDK, and exposes `execute` and `guide` over MCP.

The SDK target is TypeScript only. Code mode runs on QuickJS by default, with workerd available as an optional runtime.

## Packages

| Package | Purpose |
| --- | --- |
| `@cbxss/tack-core` | Config, manifests, operation planning, shared safe-data helpers |
| `@cbxss/tack-mcp` | MCP discovery and invocation |
| `@cbxss/tack-sources` | Source dispatch (MCP, module, and plugin sources), `defineTool` authoring API |
| `@cbxss/tack-plugin` | Plugin-bundle discovery, git fetching, lockfiles, skills, and bundled MCP servers |
| `@cbxss/tack-generator` | TypeScript SDK and docs generation |
| `@cbxss/tack-sdk-types` | Schema compilation and typed SDK declaration generation |
| `@cbxss/tack-typecheck` | Type checking for code-mode programs |
| `@cbxss/tack-codemode` | Search, describe, execution engine, runtime helpers |
| `@cbxss/tack-runtime-quickjs` | Default isolated runtime |
| `@cbxss/tack-runtime-workerd` | Optional process-isolated runtime |
| `@cbxss/tack-agent` | Agent-facing MCP server |
| `@cbxss/tack-service` | Authenticated HTTP service |
| `@cbxss/tack` | CLI entrypoint |

## Development

```sh
bun install
bun run build
bun run typecheck
bun run test
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

## Sources

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

Running `.ts` entries needs a TypeScript-aware runtime: `tack` under `tsx`/`bun`, or Node 22.18+ with type stripping. `.js` / `.mjs` entries work everywhere.

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
- The generator refuses to overwrite non-generated `.ts` files.
- MCP `execute` keeps a short dynamic description; call `guide({ name: "execute" })` for the full guide.
- Code mode provides `tools.search`, `tools.describe.tool`, `tools.call`, inferred `tools.<path>` methods, and `emit`.
- Persistent sessions (`session` tool, `execute({ session })`, `deref`) and result refs need one server instance per connection: they work over `tack mcp` (stdio) on the QuickJS runtime, not `tack host` (stateless HTTP) or workerd. Live tool-call trace streams over both as `notifications/progress`.
- Evals live in `evals/`; Kibana setup lives in `evals/kibana/`.
- `repos/` is read-only reference material and must not be imported.
