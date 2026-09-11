#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  DATASOURCES,
  END,
  START,
  METRICS,
  SERVICES,
  REGIONS,
  metricSeries,
  logs,
  annotations,
} from "./world.js";
import { DASHBOARDS, dashboard, datasource, trace } from "./catalog.js";
import { queryPrometheus, queryLogs, time, matchers } from "./query.js";

const server = new McpServer(
  { name: "instapix-mock-grafana", version: "1.0.0" },
  {
    instructions: `Self-contained synthetic Grafana fixture for Instapix, an Instagram-like app. All data is synthetic. Fixed now=${new Date(END).toISOString()}, starts=${new Date(START).toISOString()}. Discover datasources and dashboards, inspect panel queries, then query metrics/logs and correlate deployment annotations. Metrics have 60s resolution. PromQL supports selectors, rate/increase, sum/avg/min/max by, histogram_quantile, arithmetic. LogQL supports label selectors, line filters and JSON equality filters. This is a documented subset, not the official Grafana MCP server. Unsupported queries return errors. get_mock_trace and get_mock_environment are fixture extensions.`,
  },
);
const text = z.string().min(1).max(4000);
const uid = { datasourceUid: text };
const logWindow = {
  startRfc3339: text.optional(),
  endRfc3339: text.optional(),
};
const pagination = {
  limit: z.number().int().min(1).max(1000).default(100),
  page: z.number().int().min(1).default(1),
};
function register<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>) => unknown,
) {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object(shape).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(handler(args as z.infer<z.ZodObject<S>>)),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  );
}
register(
  "list_datasources",
  "List synthetic Grafana datasources; optionally filter by type.",
  { type: text.optional() },
  (args) => DATASOURCES.filter((d) => !args.type || d.type === args.type),
);
register(
  "get_datasource_by_uid",
  "Get datasource details by UID.",
  { uid: text },
  (args) => datasource(args.uid),
);
register(
  "search_dashboards",
  "Search Instapix dashboards by title; paginated.",
  { query: z.string().default(""), ...pagination },
  (args) =>
    DASHBOARDS.filter((d) =>
      d.title.toLowerCase().includes(args.query.toLowerCase()),
    )
      .slice((args.page - 1) * args.limit, args.page * args.limit)
      .map((d) => ({
        uid: d.uid,
        title: d.title,
        tags: d.tags,
        type: "dash-db",
        url: `/d/${d.uid}`,
        folderTitle: "Instapix Production",
      })),
);
register(
  "get_dashboard_by_uid",
  "Get full dashboard JSON and metadata.",
  { uid: text },
  (args) => ({
    dashboard: dashboard(args.uid),
    meta: {
      folderTitle: "Instapix Production",
      provisioned: true,
      canEdit: false,
    },
  }),
);
register(
  "get_dashboard_summary",
  "Get dashboard title, description, tags and panel summaries.",
  { uid: text },
  (args) => {
    const d = dashboard(args.uid);
    return {
      uid: d.uid,
      title: d.title,
      description: d.description,
      tags: d.tags,
      panels: d.panels.map(({ id, title, type }) => ({ id, title, type })),
    };
  },
);
register(
  "get_dashboard_panel_queries",
  "Get executable panel PromQL and datasource UIDs.",
  { uid: text },
  (args) =>
    dashboard(args.uid).panels.map((p) => ({
      panelId: p.id,
      title: p.title,
      datasource: p.datasource,
      queries: p.targets,
    })),
);
register(
  "list_prometheus_metric_names",
  "Discover metric names. Optional regex and pagination.",
  { ...uid, regex: text.optional(), ...pagination },
  (args) => {
    datasource(args.datasourceUid, "prometheus");
    const re = args.regex ? new RegExp(args.regex) : undefined;
    return Object.keys(METRICS)
      .filter((n) => !re || re.test(n))
      .slice((args.page - 1) * args.limit, args.page * args.limit);
  },
);
register(
  "list_prometheus_metric_metadata",
  "Get metric type, units and description.",
  { ...uid, metric: text.optional(), limit: pagination.limit },
  (args) => {
    datasource(args.datasourceUid, "prometheus");
    return Object.fromEntries(
      Object.entries(METRICS)
        .filter(([name]) => !args.metric || name === args.metric)
        .slice(0, args.limit)
        .map(([name, metadata]) => [name, [metadata]]),
    );
  },
);
register(
  "list_prometheus_label_names",
  "List indexed Prometheus label names.",
  uid,
  (args) => {
    datasource(args.datasourceUid, "prometheus");
    return [
      ...new Set(metricSeries().flatMap((s) => Object.keys(s.metric))),
    ].sort();
  },
);
register(
  "list_prometheus_label_values",
  'List values of a Prometheus label. Optional label matcher selector, e.g. {service="feed-api"}.',
  { ...uid, labelName: text, selector: text.optional() },
  (args) => {
    datasource(args.datasourceUid, "prometheus");
    const predicate = matchers(
      (args.selector ?? "").replace(/^\{(.*)\}$/, "$1"),
    );
    return [
      ...new Set(
        metricSeries()
          .filter((s) => predicate(s.metric))
          .map((s) => s.metric[args.labelName])
          .filter((v) => v !== undefined),
      ),
    ].sort();
  },
);
register(
  "query_prometheus",
  "Query synthetic metrics with the documented PromQL subset. Time is RFC3339 or relative to fixed now. Range step >=60s; max 100000 returned samples.",
  {
    ...uid,
    expr: text,
    endTime: text,
    startTime: text.optional(),
    stepSeconds: z.number().int().min(60).optional(),
    queryType: z.enum(["instant", "range"]).default("range"),
  },
  (args) => {
    datasource(args.datasourceUid, "prometheus");
    return queryPrometheus(args);
  },
);
register(
  "list_loki_label_names",
  "List Loki indexed label names.",
  uid,
  (args) => {
    datasource(args.datasourceUid, "loki");
    return ["service", "region", "environment", "level", "cluster"];
  },
);
register(
  "list_loki_label_values",
  "List Loki label values within a time window.",
  { ...uid, labelName: text, ...logWindow },
  (args) => {
    datasource(args.datasourceUid, "loki");
    const start = time(args.startRfc3339 ?? new Date(START).toISOString());
    const end = time(args.endRfc3339 ?? "now");
    if (start > end) throw new Error("Start must precede end");
    return [
      ...new Set(
        logs()
          .filter((l) => l.timestamp >= start && l.timestamp <= end)
          .map((l) => l.labels[args.labelName])
          .filter((v) => v !== undefined),
      ),
    ].sort();
  },
);
register(
  "query_loki_logs",
  "Query sampled JSON logs using label matchers, |=/!=/|~/!~ line filters, | json and field equality. Result streams are flattened fixture records with nanosecond timestamps; totalMatching and truncated support bounded inspection.",
  {
    ...uid,
    logql: text,
    ...logWindow,
    limit: z.number().int().min(1).max(1000).default(100),
    direction: z.enum(["forward", "backward"]).default("backward"),
  },
  (args) => {
    datasource(args.datasourceUid, "loki");
    return queryLogs(args);
  },
);
register(
  "get_annotations",
  "List deployment and mitigation annotations. Times are Unix milliseconds; tag filters use AND semantics.",
  {
    from: z.number().int().optional(),
    to: z.number().int().optional(),
    tags: z.array(text).optional(),
    limit: pagination.limit,
  },
  (args) => {
    const start = args.from ?? START;
    const end = args.to ?? END;
    if (start > end) throw new Error("from must precede to");
    return annotations()
      .filter(
        (a) =>
          a.time >= start &&
          a.time <= end &&
          (!args.tags || args.tags.every((t) => a.tags.includes(t))),
      )
      .slice(0, args.limit);
  },
);
register(
  "list_alert_rules",
  "List fixture alert rule definitions, including actionable PromQL expressions. These are definitions, not live Grafana alert evaluations.",
  {},
  () => [
    {
      uid: "feed-errors",
      title: "Feed 5xx ratio above 2%",
      condition: "A > 0.02",
      for: "5m",
      labels: { team: "discovery", severity: "critical" },
      expr: 'sum by (region) (rate(http_requests_total{service="feed-api",status="5xx"}[5m])) / sum by (region) (rate(http_requests_total{service="feed-api"}[5m]))',
    },
    {
      uid: "transcode-backlog",
      title: "Transcode queue above 10000",
      condition: "A > 10000",
      for: "10m",
      labels: { team: "media", severity: "warning" },
      expr: 'worker_queue_depth{service="transcoder"}',
    },
    {
      uid: "rebuffer",
      title: "Video buffering above 5%",
      condition: "A > 0.05",
      for: "5m",
      labels: { team: "video", severity: "critical" },
      expr: "video_rebuffer_ratio",
    },
  ],
);
register(
  "get_mock_trace",
  "Fixture extension: follow a trace_id from a sampled log into illustrative dependency spans. Not an official Grafana MCP tool or full Tempo query engine.",
  { ...uid, traceId: text },
  (args) => {
    datasource(args.datasourceUid, "tempo");
    return trace(args.traceId);
  },
);
register(
  "get_mock_environment",
  "Fixture extension: dataset clock, scale, ownership and query limitations; no incident answers.",
  {},
  () => ({
    app: "Instapix",
    synthetic: true,
    start: new Date(START).toISOString(),
    now: new Date(END).toISOString(),
    regions: REGIONS,
    services: SERVICES,
    logCount: 120000,
    metricSeries: metricSeries().length,
    metricResolutionSeconds: 60,
    sampleCountPerSeries: 2881,
    limitations: [
      "No writes, real Grafana UI, live ingestion or network calls",
      "PromQL subset only; no offset, subqueries, joins, regex metric names or recording rules",
      "LogQL log queries only; no metric pipelines",
      "Logs are sampled; their counts do not equal metric traffic",
      "Trace dependency spans are illustrative",
      "No live alert evaluation or Grafana Incident API",
    ],
  }),
);
await server.connect(new StdioServerTransport());
