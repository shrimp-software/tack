# Tack Evals

Codex-backed evals that exercise the Tack MCP server on real agent tasks.

```sh
cp evals/eval.config.example.json evals/eval.config.local.json
bun run eval -- --config evals/eval.config.local.json
```

The runner executes each case once per target with `codex exec --json`, injects
exactly one MCP server for that target, and writes artifacts under `evals/runs/`.

## What It Records

- final Codex answer
- raw Codex JSONL event stream
- stderr
- duration
- Codex token usage when present

## Config

Each target is an MCP server launch command or a Streamable HTTP URL. Codex auth
can be explicitly inherited:

```json
{
  "codex": {
    "envFromProcess": ["CODEX_HOME", "OPENAI_API_KEY"]
  }
}
```

Artifacts only store env var names, not values.

Run Tack from source over stdio:

```json
{
  "id": "tack",
  "mcpName": "tack",
  "command": "bun",
  "args": ["run", "--cwd", "packages/cli", "dev", "--", "mcp", "--config", "${TACK_CONFIG}"]
}
```

Or point Codex at an HTTP MCP server:

```json
{
  "id": "kibana-direct",
  "mcpName": "kibana",
  "url": "http://localhost:5601/api/agent_builder/mcp",
  "bearerTokenEnvVar": "KIBANA_API_KEY"
}
```

`tack.config.json` must point at a real upstream MCP server (e.g. Grafana MCP).
Kibana-specific setup lives in `evals/kibana/`.
