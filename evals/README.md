# Tack Evals

Codex-backed evals for comparing Tack and Executor MCP behavior.

```sh
cp evals/eval.config.example.json evals/eval.config.local.json
bun run eval -- --config evals/eval.config.local.json
```

The runner executes each case once per target with `codex exec --json`, injects exactly one MCP server for that target, and writes artifacts under `evals/runs/`.

## What It Records

- final Codex answer
- raw Codex JSONL event stream
- stderr
- duration
- Codex token usage when present
- pairwise text similarity between target answers

## Config

Targets are MCP server launch commands or Streamable HTTP URLs. Codex auth can be explicitly inherited:

```json
{
  "codex": {
    "envFromProcess": ["CODEX_HOME", "OPENAI_API_KEY"]
  }
}
```

Artifacts only store env var names, not values.

Use local stdio binaries:

```json
{
  "id": "executor",
  "mcpName": "executor",
  "command": "executor",
  "args": ["mcp"]
}
```

Or wrap them in a container:

```json
{
  "id": "executor-docker",
  "mcpName": "executor",
  "command": "docker",
  "args": ["run", "--rm", "-i", "executor:local", "mcp"]
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

Tack needs a real `tack.config.json` that points at Grafana MCP. Executor needs a local profile/integration that exposes Grafana.

Kibana-specific setup lives in `evals/kibana/`.
