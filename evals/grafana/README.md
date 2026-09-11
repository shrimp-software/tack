# Instapix mock Grafana MCP

A self-contained, deterministic downstream MCP server for investigating a fictional Instagram-like app through Tack. No Docker, credentials, Grafana instance, or external API calls are needed. This implements a **documented subset** of Grafana-style tools, not the official Grafana MCP server.

## Run

From the repository root, with dependencies installed and workspace packages built:

```sh
bun run eval:grafana:config
bun run --cwd packages/cli dev -- mcp --config ../../evals/.local/tack.grafana-mock.config.json
```

The config writer records absolute paths. For direct MCP access, configure a stdio client to launch `bun run /absolute/path/to/tack/evals/grafana/server.ts`. `bun run eval:grafana:serve` starts that server; stdout is reserved for MCP messages.

```sh
TMPDIR=/dev/shm bun run eval:grafana:test
bun run eval:typecheck
```

`TMPDIR=/dev/shm` is useful on Linux when `/tmp` has a per-user quota. It can be omitted elsewhere.

## Dataset

| Dimension  | Contents                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clock      | 2026-09-07 18:00 UTC through 2026-09-09 18:00 UTC; `now` always means the latter                                                                         |
| Services   | 16: gateway, feed, ranking, Redis, media, transcoder, storage, reels, CDN, messaging, Kafka, notifications, auth, social graph, Postgres, search         |
| Regions    | us-east-1, eu-west-1, ap-southeast-1                                                                                                                     |
| Metrics    | 13 metric names, 753 series, 2,169,393 samples; counters, latency histogram buckets, resource health and product experience ratios; 60-second resolution |
| Logs       | 120,000 JSON records with trace/request/user IDs, region, pod, version, platform, dependency and sampling rate                                           |
| Dashboards | Six dashboards with 18 executable panel queries                                                                                                          |
| Events     | Deployments and mitigations; three alert definitions                                                                                                     |
| Traces     | Dependency spans derived from sampled log requests, accessed with the fixture extension `get_mock_trace`                                                 |

Traffic includes regional daily cycles and deterministic noise. Errors receive 10x the log sampling weight of successful requests; log counts do not equal metric request counts. Metric counters are cumulative and histogram buckets share a distribution with the duration sum/count. Logs are sampled illustrative requests, not a reconstruction of every metric event. CPU-only batch load provides a healthy distractor.

Four incident windows exercise feed degradation, stuck upload processing, delayed message delivery, and ongoing video buffering. Regional controls and recovery windows let an investigator test a hypothesis. The evaluator-only `groundTruth()` export in `catalog.ts` holds the answer key; no MCP tool exposes it.

## Investigation examples

- “Home feed was slow earlier today. Find the affected region, correlate errors and latency with a deployment and dependency logs, and check whether it recovered.”
- “Why were reels uploads stuck yesterday evening? Quantify the queue buildup and find worker evidence.”
- “Users in Singapore report buffering now. Compare other regions, identify the failing dependency, and cite a trace and relevant change.”
- “Was last night's search CPU peak an outage? Check customer-facing errors and latency before concluding.”

Start with `get_mock_environment`, `list_datasources`, and `search_dashboards`. Use `get_dashboard_panel_queries` for valid query examples. Follow `trace_id` values from Loki into `get_mock_trace` with datasource UID `tempo-social`.

## Query contract

Prometheus tools accept `datasourceUid: "prom-social"`. `query_prometheus` accepts `expr`, `endTime`, `queryType` (`instant` or default `range`), and for ranges `startTime` and `stepSeconds >= 60`. Times accept RFC3339, `now`, or a single relative duration such as `now-3h`. Queries outside the fixture window return no samples. Results use `{data: [...]}` with Prometheus-style `metric` labels and `value` or `values` tuples.

Supported PromQL:

```promql
cache_hit_ratio{service="redis-feed",region="us-east-1"}
sum by (region) (rate(http_requests_total{service="feed-api",status="5xx"}[5m])) / sum by (region) (rate(http_requests_total{service="feed-api"}[5m]))
histogram_quantile(0.95, sum by (le, region) (rate(http_request_duration_seconds_bucket{service="feed-api"}[5m])))
```

Selectors support `=`, `!=`, `=~`, `!~`; regex label matches are anchored. `rate` and `increase` support integer minute/hour windows. `sum`, `avg`, `min`, `max`, optional `by (...)`, histogram quantiles, parentheses and arithmetic are composable. Vector arithmetic matches identical non-name labels. No joins, offsets, subqueries, arbitrary PromQL functions or full Prometheus evaluation semantics. Range queries are capped at 2,881 steps and 100,000 samples.

Loki tools accept `datasourceUid: "loki-social"`. `query_loki_logs` accepts `logql`, optional `startRfc3339`, `endRfc3339`, `limit` (1–1,000) and `direction`. Default window is the last hour.

```logql
{service="ranking",region="us-east-1",level=~"error|warn"} |= "cache"
{service="cdn-edge"} |= "edge-route-884" | json | status="503"
```

Line filters support `|=`, `!=`, `|~`, `!~`; JSON fields support string comparisons and regex after `| json`. Results contain flattened `streams` records (`labels`, nanosecond `timestamp`, JSON `line`), `totalMatching`, and `truncated`. This envelope is fixture-specific. LogQL metric queries and other pipelines are rejected. Unsupported syntax and unknown datasource UIDs are tool errors.

The catalog has 18 read-only tools. `get_mock_environment` and `get_mock_trace` are explicit extensions. There is no real Grafana UI, ingestion backend, write API, live alert evaluation, Grafana Incident service, or full Tempo query engine. Tool names and common parameters were checked against [Grafana MCP](https://github.com/grafana/mcp-grafana); this fixture does not claim complete schema or response compatibility.

## Optional agent eval

```sh
bun run eval:grafana:config
bun run eval -- --config evals/eval.grafana-mock.config.example.json
```

This launches Codex using the existing eval runner and requires the user's Codex authentication. It is separate from the local automated tests and may consume model usage. Both direct Grafana mock and Tack-wrapped targets use the same immutable dataset. Cases contain investigation tasks and expected evidence, with no fabricated model-run scores.
