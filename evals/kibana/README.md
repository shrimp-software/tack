# Kibana Eval

Local Kibana and Elasticsearch harness for running Tack evals on log-heavy MCP workflows.

```sh
bun run eval:kibana:up
bun run eval:kibana:seed
bun run eval:kibana:config
bun run eval -- --config evals/eval.kibana.config.example.json --target tack-kibana
```

Defaults:

- Kibana: `http://localhost:5601`
- Elasticsearch: `http://localhost:9200`
- MCP endpoint: `http://localhost:5601/api/agent_builder/mcp`
- Seed index: `tack-eval-logs`
- Seed count: `50000`

Set `KIBANA_EVAL_LOG_COUNT` to seed more logs.

## Auth

The local compose stack starts without Elastic security for fast eval setup. For secured Kibana or Elastic Cloud, set:

```sh
export KIBANA_MCP_URL="https://your-kibana.example.com/api/agent_builder/mcp"
export KIBANA_API_KEY="..."
bun run eval:kibana:config
```

The eval runner explicitly passes Codex auth env vars such as `CODEX_HOME` and `OPENAI_API_KEY`, but artifacts only record env var names.

## Targets

`tack-kibana` wraps Kibana MCP through Tack. `kibana-direct` exercises Kibana's HTTP MCP server directly.

Elastic documents the Agent Builder MCP endpoint as `{KIBANA_URL}/api/agent_builder/mcp`; custom spaces use `/s/{SPACE_NAME}/api/agent_builder/mcp`.
