import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import {
  createMcpRuntime,
  discoverMcpManifestPromise,
} from "../../packages/mcp/src/index.js";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createTackAgentServer } from "../../packages/agent/src/index.js";
import { createQuickJSRuntime } from "@cbxss/tack-runtime-quickjs";
import { listOperations } from "@cbxss/tack-core";
import { END, START, MINUTE, INCIDENTS, metricSeries, logs } from "./world.js";
import { DASHBOARDS, trace } from "./catalog.js";
import { compile, queryPrometheus, queryLogs } from "./query.js";

describe("Instapix Grafana dataset", () => {
  it("contains 120000 reproducible logs, valid timestamps and unique trace ids", () => {
    const records = logs();
    expect(records).toHaveLength(120000);
    expect(new Set(records.map((l) => l.fields.trace_id)).size).toBe(
      records.length,
    );
    expect(
      records.every(
        (l) => l.timestamp >= START && l.timestamp <= END && l.fields.synthetic,
      ),
    ).toBe(true);
    expect(new Set(records.map((l) => l.labels.service)).size).toBe(16);
    expect(new Set(records.map((l) => l.labels.region)).size).toBe(3);
  });
  it("keeps counters monotonic and histogram counts consistent", () => {
    for (const series of metricSeries().filter((s) =>
      s.metric.__name__!.startsWith("http_"),
    )) {
      for (let n = 1; n < series.values.length; n++)
        if (series.values[n]! < series.values[n - 1]!)
          throw new Error(
            `Counter decreased: ${JSON.stringify(series.metric)} at ${n}`,
          );
    }
    const buckets = compile(
      'http_request_duration_seconds_bucket{service="feed-api",region="us-east-1",le="+Inf"}',
    )(END)[0]!.value;
    const count = compile(
      'http_request_duration_seconds_count{service="feed-api",region="us-east-1"}',
    )(END)[0]!.value;
    expect(buckets).toBe(count);
    const total = compile(
      'sum(http_requests_total{service="feed-api",region="us-east-1"})',
    )(END)[0]!.value;
    expect(total).toBeCloseTo(count, 3);
  });
  it("correlates feed errors, cache misses and latency while preserving healthy regions and recovery", () => {
    const incident = INCIDENTS[0]!;
    const during = incident.start + 20 * MINUTE;
    const errors = compile(
      'sum by (region) (rate(http_requests_total{service="feed-api",status="5xx"}[5m])) / sum by (region) (rate(http_requests_total{service="feed-api"}[5m]))',
    );
    expect(
      errors(during).find((r) => r.metric.region === "us-east-1")!.value,
    ).toBeCloseTo(0.121, 3);
    expect(
      errors(during).find((r) => r.metric.region === "eu-west-1")!.value,
    ).toBeCloseTo(0.001, 3);
    expect(errors(END).every((r) => r.value < 0.002)).toBe(true);
    const p95 = compile(
      'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{service="feed-api",region="us-east-1"}[5m])))',
    );
    expect(p95(during)[0]!.value).toBeGreaterThan(p95(END)[0]!.value * 8);
    expect(
      compile('cache_hit_ratio{service="redis-feed",region="us-east-1"}')(
        during,
      )[0]!.value,
    ).toBeCloseTo(0.25);
  });
  it("exposes independently corroborating logs for every incident without leaking the answer key", () => {
    for (const incident of INCIDENTS) {
      const result = queryLogs({
        logql: `{service="${incident.root}",region="${incident.region}",level=~"error|warn"}`,
        startRfc3339: new Date(incident.start).toISOString(),
        endRfc3339: new Date(Math.min(END, incident.end)).toISOString(),
        limit: 1000,
      });
      expect(result.totalMatching).toBeGreaterThan(5);
      expect(JSON.stringify(result)).not.toContain(incident.id);
      const fields = JSON.parse(result.streams[0]!.line);
      const sampled = trace(fields.trace_id);
      expect(sampled.spans[0]!.serviceName).toBe(incident.root);
      expect(sampled.spans[0]!.traceId).toBe(fields.trace_id);
    }
  });
  it("executes every dashboard expression and respects range windows", () => {
    for (const dashboard of DASHBOARDS)
      for (const panel of dashboard.panels) {
        const result = queryPrometheus({
          expr: panel.targets[0]!.expr,
          startTime: "now-3h",
          endTime: "now",
          stepSeconds: 300,
        });
        expect(result.data.length).toBeGreaterThan(0);
        expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
      }
    expect(compile("cache_hit_ratio")(START - MINUTE)).toEqual([]);
    expect(compile("rate(http_requests_total[5m])")(START)).toEqual([]);
    expect(compile('http_requests_total{service="missing"}')(END)).toEqual([]);
  });
  it("filters logs by labels, fields, time and direction, and reports truncation", () => {
    const args = {
      logql:
        '{service="cdn-edge",region="ap-southeast-1"} |= "edge-route-884" | json | status="503"',
      startRfc3339: "now-35m",
      limit: 2,
    };
    const result = queryLogs(args);
    expect(result.totalMatching).toBeGreaterThan(2);
    expect(result.truncated).toBe(true);
    expect(result.streams).toHaveLength(2);
    expect(BigInt(result.streams[0]!.timestamp)).toBeGreaterThan(
      BigInt(result.streams[1]!.timestamp),
    );
    expect(result.streams.every((l) => JSON.parse(l.line).status === 503)).toBe(
      true,
    );
    expect(
      queryLogs({ ...args, direction: "forward" }).streams[0]!.timestamp,
    ).not.toBe(result.streams[0]!.timestamp);
  });
  it("rejects unsupported syntax and invalid bounds instead of returning invented answers", () => {
    expect(() => compile("made_up(rate(http_requests_total[5m]))")).toThrow(
      "Unsupported",
    );
    expect(() => compile("rate(cache_hit_ratio[5m])")).toThrow("counter");
    expect(() =>
      compile('cache_hit_ratio{region="us-east-1"} garbage'),
    ).toThrow();
    expect(() =>
      queryPrometheus({
        expr: "cache_hit_ratio",
        startTime: "now",
        endTime: "now-1h",
        stepSeconds: 60,
      }),
    ).toThrow();
    expect(() =>
      queryLogs({ logql: '{service="feed-api"} | unknown' }),
    ).toThrow("Unsupported");
    expect(() => queryLogs({ logql: "{}", limit: 0 })).toThrow();
  });
});

describe("Tack to mock Grafana over real stdio MCP", () => {
  it("discovers tools and queries an incident through Tack's MCP adapter", async () => {
    const config = {
      servers: {
        grafana: {
          transport: "stdio" as const,
          command: "bun",
          args: [fileURLToPath(new URL("server.ts", import.meta.url))],
        },
      },
    };
    const manifest = await discoverMcpManifestPromise(config);
    const tools = Object.values(manifest.tools);
    expect(tools.length).toBe(18);
    const runtime = await createMcpRuntime({ config, manifest });
    const invoke = (name: string, args: Record<string, unknown>) =>
      runtime.invoke(tools.find((t) => t.upstreamName === name)!.id, args);
    try {
      const ds = await invoke("list_datasources", {});
      expect(ds.isError).toBe(false);
      expect(JSON.stringify(ds)).toContain("prom-social");
      const result = await invoke("query_prometheus", {
        datasourceUid: "prom-social",
        expr: 'cache_hit_ratio{service="cdn-edge",region="ap-southeast-1"}',
        endTime: "now",
        queryType: "instant",
      });
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result)).toContain("0.52");
      const log = await invoke("query_loki_logs", {
        datasourceUid: "loki-social",
        logql: '{service="cdn-edge"} |= "edge-route-884"',
        limit: 3,
      });
      expect(log.isError).toBe(false);
      expect(JSON.stringify(log)).toContain("edge-route-884");
      const invalid = await invoke("query_prometheus", {
        datasourceUid: "missing",
        expr: "cache_hit_ratio",
        endTime: "now",
        queryType: "instant",
      });
      expect(invalid.isError).toBe(true);
      const unsupported = await invoke("query_prometheus", {
        datasourceUid: "prom-social",
        expr: "abs(cache_hit_ratio)",
        endTime: "now",
        queryType: "instant",
      });
      expect(unsupported.isError).toBe(true);
      const server = createTackAgentServer({
        manifest,
        runtime,
        codeRuntime: createQuickJSRuntime({ timeoutMs: 10000 }),
      });
      const client = new Client({
        name: "grafana-fixture-test",
        version: "1.0.0",
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([
          server.connect(serverTransport),
          client.connect(clientTransport),
        ]);
        const discovery = await client.callTool({
          name: "execute",
          arguments: {
            code: 'return await tools.search({ query: "synthetic metrics", namespace: "grafana", limit: 30 });',
          },
        });
        expect(discovery.isError).not.toBe(true);
        expect(JSON.stringify(discovery.structuredContent)).toContain("query");
        // Resolve the live shaped path, rather than assuming tool-name-to-path conventions.
        const tool = tools.find((t) => t.upstreamName === "query_prometheus")!;
        const operation = listOperations(manifest).find(
          (o) => o.toolId === tool.id,
        )!;
        const execution = await client.callTool({
          name: "execute",
          arguments: {
            code: `return await tools.call(${JSON.stringify(operation.fullPathString)}, { datasourceUid: "prom-social", expr: 'cache_hit_ratio{service="cdn-edge",region="ap-southeast-1"}', endTime: "now", queryType: "instant" });`,
          },
        });
        expect(execution.structuredContent).toMatchObject({
          status: "completed",
        });
        expect(JSON.stringify(execution.structuredContent)).toContain("0.52");
        const compact = (execution.structuredContent as { result: Record<string, unknown> }).result;
        expect(compact).toMatchObject({ ok: true, responseId: expect.any(String) });
        // the raw MCP envelope never rides along in the code-mode result
        expect(compact).not.toHaveProperty("raw");
        expect(compact).not.toHaveProperty("text");
        expect(compact).not.toHaveProperty("delivery");
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await runtime.close();
    }
  }, 30000);
});
