import {
  DATASOURCES,
  END,
  START,
  SERVICES,
  INCIDENTS,
  annotations,
  logs,
} from "./world.js";

const definitions = [
  [
    "overview",
    "Instapix / Production overview",
    "platform",
    "",
    [
      "sum by (service) (rate(http_requests_total[5m]))",
      'sum by (service) (rate(http_requests_total{status="5xx"}[5m])) / sum by (service) (rate(http_requests_total[5m]))',
      "histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))",
    ],
  ],
  [
    "feed",
    "Instapix / Home feed and ranking",
    "discovery",
    "feed-api",
    [
      'histogram_quantile(0.95, sum by (le, region) (rate(http_request_duration_seconds_bucket{service="feed-api"}[5m])))',
      'cache_hit_ratio{service="redis-feed"}',
      "feed_engagement_ratio",
    ],
  ],
  [
    "media",
    "Instapix / Uploads and transcoding",
    "media",
    "media-api",
    [
      'worker_queue_depth{service="transcoder"}',
      "gpu_worker_restarts_per_hour",
      "upload_completion_ratio",
    ],
  ],
  [
    "reels",
    "Instapix / Reels playback and CDN",
    "video",
    "reels-api",
    [
      "video_rebuffer_ratio",
      'cache_hit_ratio{service="cdn-edge"}',
      'histogram_quantile(0.95, sum by (le, region) (rate(http_request_duration_seconds_bucket{service="reels-api"}[5m])))',
    ],
  ],
  [
    "social",
    "Instapix / Messaging and notifications",
    "social",
    "messaging",
    [
      "kafka_consumer_lag",
      "node_disk_utilization_ratio",
      'sum by (region) (rate(http_requests_total{service="messaging",status="5xx"}[5m]))',
    ],
  ],
  [
    "infra",
    "Instapix / Infrastructure and capacity",
    "storage",
    "",
    [
      "container_cpu_utilization_ratio",
      "node_disk_utilization_ratio",
      "sum by (service, region) (rate(http_requests_total[5m]))",
    ],
  ],
] as const;
export const DASHBOARDS = definitions.map(
  ([uid, title, team, service, queries], index) => ({
    id: index + 1,
    uid: `instapix-${uid}`,
    title,
    tags: ["instapix", "production", team],
    schemaVersion: 39,
    version: 1,
    timezone: "utc",
    time: {
      from: new Date(START).toISOString(),
      to: new Date(END).toISOString(),
    },
    description: `Synthetic Instapix telemetry. Fixed now: ${new Date(END).toISOString()}. 60-second metric resolution; sampled logs. Owner: ${team}.`,
    panels: queries.map((expr, n) => ({
      id: n + 1,
      title: [
        "Traffic / primary signal",
        "Errors / dependency health",
        "Experience / latency",
      ][n]!,
      type: "timeseries",
      datasource: { type: "prometheus", uid: "prom-social" },
      targets: [{ refId: "A", expr }],
      gridPos: { x: n * 8, y: 0, w: 8, h: 9 },
    })),
    annotations: {
      list: [
        {
          name: "Deployments",
          datasource: { type: "grafana", uid: "-- Grafana --" },
          enable: true,
          tags: ["deployment"],
        },
      ],
    },
    links: [
      {
        title: "Service ownership and runbook",
        url: `https://runbooks.synthetic.invalid/${service || team}`,
      },
    ],
  }),
);
export function dashboard(uid: string) {
  const result = DASHBOARDS.find((d) => d.uid === uid);
  if (!result) throw new Error(`Dashboard not found: ${uid}`);
  return result;
}
export function datasource(uid: string, expected?: string) {
  const result = DATASOURCES.find((d) => d.uid === uid);
  if (!result || (expected && result.type !== expected))
    throw new Error(`Unknown ${expected ?? ""} datasource: ${uid}`);
  return result;
}
export function trace(traceId: string) {
  const log = logs().find((l) => l.fields.trace_id === traceId);
  if (!log) throw new Error(`Trace not found: ${traceId}`);
  const chain: string[] = [];
  let service = SERVICES.find((s) => s.name === log.labels.service);
  while (service && !chain.includes(service.name)) {
    chain.push(service.name);
    service = SERVICES.find((s) => s.name === service?.dependency);
  }
  const duration = Number(log.fields.duration_ms);
  return {
    traceId,
    synthetic: true,
    sampling:
      "Derived dependency spans for the sampled log request; illustrative, not a full Tempo API",
    spans: chain.map((name, index) => ({
      traceId,
      spanId:
        index === 0
          ? log.fields.span_id
          : `${log.fields.span_id}`.slice(0, 12) +
            index.toString(16).padStart(4, "0"),
      parentSpanId:
        index === 0
          ? null
          : index === 1
            ? log.fields.span_id
            : `${log.fields.span_id}`.slice(0, 12) +
              (index - 1).toString(16).padStart(4, "0"),
      serviceName: name,
      operationName: index === 0 ? "request" : "dependency.call",
      startTimeUnixNano: `${BigInt(log.timestamp + index) * 1000000n}`,
      durationMs: Math.max(1, duration - index * 2),
      status: log.fields.status === 503 ? "ERROR" : "OK",
      attributes: {
        region: log.labels.region,
        "deployment.environment": "production",
        "service.version": index === 0 ? log.fields.version : "unknown",
      },
    })),
  };
}
// Kept separate from the agent-facing tool catalog so evaluation answers are not leaked.
export function groundTruth() {
  return {
    synthetic: true,
    start: new Date(START).toISOString(),
    end: new Date(END).toISOString(),
    incidents: INCIDENTS,
    annotations: annotations(),
  };
}
