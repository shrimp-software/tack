/** Deterministic synthetic production telemetry. No customer data or network access. */
export const MINUTE = 60_000;
export const END = Date.parse("2026-09-09T18:00:00Z");
export const START = END - 48 * 60 * MINUTE;
export const REGIONS = ["us-east-1", "eu-west-1", "ap-southeast-1"] as const;
export const SERVICES = [
  {
    name: "api-gateway",
    team: "platform",
    rpm: 180000,
    latency: 0.12,
    dependency: "feed-api",
  },
  {
    name: "feed-api",
    team: "discovery",
    rpm: 96000,
    latency: 0.09,
    dependency: "ranking",
  },
  {
    name: "ranking",
    team: "ml-platform",
    rpm: 78000,
    latency: 0.055,
    dependency: "redis-feed",
  },
  {
    name: "redis-feed",
    team: "storage",
    rpm: 240000,
    latency: 0.003,
    dependency: "",
  },
  {
    name: "media-api",
    team: "media",
    rpm: 28000,
    latency: 0.14,
    dependency: "transcoder",
  },
  {
    name: "transcoder",
    team: "media",
    rpm: 4800,
    latency: 0.8,
    dependency: "object-storage",
  },
  {
    name: "object-storage",
    team: "storage",
    rpm: 42000,
    latency: 0.025,
    dependency: "",
  },
  {
    name: "reels-api",
    team: "video",
    rpm: 65000,
    latency: 0.08,
    dependency: "cdn-edge",
  },
  {
    name: "cdn-edge",
    team: "edge",
    rpm: 360000,
    latency: 0.012,
    dependency: "object-storage",
  },
  {
    name: "messaging",
    team: "social",
    rpm: 34000,
    latency: 0.04,
    dependency: "kafka",
  },
  {
    name: "kafka",
    team: "streaming",
    rpm: 160000,
    latency: 0.006,
    dependency: "",
  },
  {
    name: "notifications",
    team: "social",
    rpm: 28000,
    latency: 0.03,
    dependency: "kafka",
  },
  {
    name: "auth",
    team: "identity",
    rpm: 15000,
    latency: 0.035,
    dependency: "postgres",
  },
  {
    name: "social-graph",
    team: "social",
    rpm: 55000,
    latency: 0.022,
    dependency: "postgres",
  },
  {
    name: "postgres",
    team: "storage",
    rpm: 120000,
    latency: 0.008,
    dependency: "",
  },
  {
    name: "search",
    team: "discovery",
    rpm: 19000,
    latency: 0.065,
    dependency: "social-graph",
  },
] as const;
export type Service = (typeof SERVICES)[number];
export type Labels = Record<string, string>;
export interface Incident {
  id: string;
  title: string;
  region: string;
  start: number;
  end: number;
  services: string[];
  root: string;
  evidence: string;
  mitigation: string;
}
export const INCIDENTS: Incident[] = [
  {
    id: "INC-2401",
    title: "Home feed latency and errors",
    region: "us-east-1",
    start: END - 150 * MINUTE,
    end: END - 95 * MINUTE,
    services: ["redis-feed", "ranking", "feed-api", "api-gateway"],
    root: "ranking",
    evidence:
      "ranking v2.18.0 changed cache key namespace; cache misses saturate redis-feed connections",
    mitigation: "Rolled ranking back to v2.17.3 and warmed feed cache",
  },
  {
    id: "INC-2398",
    title: "Reels uploads stuck processing",
    region: "eu-west-1",
    start: END - 19 * 60 * MINUTE,
    end: END - 17 * 60 * MINUTE,
    services: ["transcoder", "media-api"],
    root: "transcoder",
    evidence:
      "transcoder v3.8.1 leaks GPU memory on HEVC inputs; worker restarts exceed capacity",
    mitigation: "Pinned HEVC jobs to v3.8.0 and expanded worker pool",
  },
  {
    id: "INC-2395",
    title: "Delayed direct messages and notifications",
    region: "ap-southeast-1",
    start: END - 31 * 60 * MINUTE,
    end: END - 30 * 60 * MINUTE,
    services: ["kafka", "messaging", "notifications"],
    root: "kafka",
    evidence:
      "broker-2 disk reaches 96 percent; under-replicated partitions stall acknowledgements",
    mitigation: "Expanded broker disk and reassigned hot partitions",
  },
  {
    id: "INC-2402",
    title: "Reels playback buffering",
    region: "ap-southeast-1",
    start: END - 35 * MINUTE,
    end: END + 60 * MINUTE,
    services: ["cdn-edge", "reels-api"],
    root: "cdn-edge",
    evidence:
      "CDN route policy sends Singapore traffic to distant origin; cache hit ratio falls",
    mitigation: "Revert route policy edge-route-884; investigation ongoing",
  },
];
export const DATASOURCES = [
  {
    id: 1,
    uid: "prom-social",
    name: "Instapix Production Metrics",
    type: "prometheus",
    isDefault: true,
    url: "http://prometheus.synthetic.invalid",
  },
  {
    id: 2,
    uid: "loki-social",
    name: "Instapix Production Logs",
    type: "loki",
    isDefault: false,
    url: "http://loki.synthetic.invalid",
  },
  {
    id: 3,
    uid: "tempo-social",
    name: "Instapix Sampled Traces",
    type: "tempo",
    isDefault: false,
    url: "http://tempo.synthetic.invalid",
  },
];
export function hash(text: string): number {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  // Avalanche adjacent sequence keys so service, region and outcome remain independent.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function incidentAt(
  service: string,
  region: string,
  time: number,
): Incident | undefined {
  return INCIDENTS.find(
    (i) =>
      i.region === region &&
      i.services.includes(service) &&
      time >= i.start &&
      time < i.end,
  );
}
export function signals(service: Service, region: string, time: number) {
  const minute = Math.floor((time - START) / MINUTE);
  const phase = region === "us-east-1" ? -5 : region === "eu-west-1" ? 1 : 8;
  const hour = new Date(time).getUTCHours() + phase;
  const daily = 0.72 + 0.28 * Math.cos(((hour - 20) / 24) * 2 * Math.PI);
  const noise = 0.94 + hash(`${service.name}:${region}:${minute}`) * 0.12;
  const incident = incidentAt(service.name, region, time);
  const severity = incident
    ? Math.min(
        1,
        (time - incident.start) / (5 * MINUTE) + 0.1,
        (incident.end - time) / (8 * MINUTE) + 0.1,
      )
    : 0;
  const feed = incident?.id === "INC-2401" ? severity : 0;
  const media = incident?.id === "INC-2398" ? severity : 0;
  const queue = incident?.id === "INC-2395" ? severity : 0;
  const cdn = incident?.id === "INC-2402" ? severity : 0;
  const regionShare =
    region === "us-east-1" ? 0.5 : region === "eu-west-1" ? 0.3 : 0.2;
  return {
    rpm: service.rpm * regionShare * daily * noise,
    errorRatio: 0.001 + feed * 0.12 + media * 0.08 + queue * 0.06 + cdn * 0.025,
    latency:
      service.latency *
      noise *
      (1 + feed * 18 + media * 10 + queue * 12 + cdn * 14),
    cacheHit: 0.97 - feed * 0.72 - cdn * 0.45,
    lag: 30 + queue * 85000 + media * 34000,
    // A healthy nightly batch is a deliberate distractor: CPU alone is not an outage.
    cpu: Math.min(
      0.99,
      0.25 * noise +
        severity * 0.58 +
        (service.name === "search" && hour % 24 === 2 ? 0.5 : 0),
    ),
    disk: 0.48 + queue * 0.48,
    restarts: media * 18,
    version:
      feed && service.name === "ranking"
        ? "v2.18.0"
        : media && service.name === "transcoder"
          ? "v3.8.1"
          : "stable",
    incident,
  };
}
export const METRICS = {
  http_requests_total: {
    type: "counter",
    help: "Completed service requests by status class",
    unit: "requests",
  },
  http_request_duration_seconds_bucket: {
    type: "counter",
    help: "Cumulative request duration histogram buckets",
    unit: "seconds",
  },
  http_request_duration_seconds_sum: {
    type: "counter",
    help: "Total request duration",
    unit: "seconds",
  },
  http_request_duration_seconds_count: {
    type: "counter",
    help: "Request duration observations",
    unit: "requests",
  },
  cache_hit_ratio: {
    type: "gauge",
    help: "Cache hits divided by lookups",
    unit: "ratio",
  },
  worker_queue_depth: {
    type: "gauge",
    help: "Jobs awaiting processing",
    unit: "jobs",
  },
  kafka_consumer_lag: {
    type: "gauge",
    help: "Unconsumed records",
    unit: "records",
  },
  container_cpu_utilization_ratio: {
    type: "gauge",
    help: "Fraction of allocated CPU used",
    unit: "ratio",
  },
  node_disk_utilization_ratio: {
    type: "gauge",
    help: "Fraction of broker disk used",
    unit: "ratio",
  },
  gpu_worker_restarts_per_hour: {
    type: "gauge",
    help: "Worker restarts observed over the previous hour (modeled)",
    unit: "restarts",
  },
  feed_engagement_ratio: {
    type: "gauge",
    help: "Engaged feed impressions divided by total impressions",
    unit: "ratio",
  },
  upload_completion_ratio: {
    type: "gauge",
    help: "Uploads completing within processing SLO",
    unit: "ratio",
  },
  video_rebuffer_ratio: {
    type: "gauge",
    help: "Playback time spent buffering",
    unit: "ratio",
  },
} as const;
export type MetricName = keyof typeof METRICS;
export interface Series {
  metric: Labels;
  values: Float64Array;
}
let cachedSeries: Series[] | undefined;
export function metricSeries(): Series[] {
  if (cachedSeries) return cachedSeries;
  const result: Series[] = [];
  for (const service of SERVICES)
    for (const region of REGIONS) {
      const states = Array.from({ length: 2881 }, (_, minute) =>
        signals(service, region, START + minute * MINUTE),
      );
      for (const name of Object.keys(METRICS) as MetricName[]) {
        if (
          name === "cache_hit_ratio" &&
          !["redis-feed", "cdn-edge"].includes(service.name)
        )
          continue;
        if (name === "worker_queue_depth" && service.name !== "transcoder")
          continue;
        if (
          name === "kafka_consumer_lag" &&
          !["kafka", "messaging", "notifications"].includes(service.name)
        )
          continue;
        if (name === "node_disk_utilization_ratio" && service.name !== "kafka")
          continue;
        if (
          name === "gpu_worker_restarts_per_hour" &&
          service.name !== "transcoder"
        )
          continue;
        if (name === "feed_engagement_ratio" && service.name !== "feed-api")
          continue;
        if (name === "upload_completion_ratio" && service.name !== "media-api")
          continue;
        if (name === "video_rebuffer_ratio" && service.name !== "reels-api")
          continue;
        const variants =
          name === "http_requests_total"
            ? ["2xx", "4xx", "5xx"]
            : name.endsWith("_bucket")
              ? ["0.01", "0.05", "0.1", "0.25", "0.5", "1", "2.5", "5", "+Inf"]
              : [""];
        for (const variant of variants) {
          const metric: Labels = {
            __name__: name,
            service: service.name,
            region,
            environment: "production",
            team: service.team,
            cluster: `instapix-${region}`,
          };
          if (name === "http_requests_total") metric.status = variant;
          if (name.endsWith("_bucket")) metric.le = variant;
          let counter = 0;
          const values = Float64Array.from(states, (s) => {
            let value: number;
            switch (name) {
              case "http_requests_total":
                value =
                  s.rpm *
                  (variant === "5xx"
                    ? s.errorRatio
                    : variant === "4xx"
                      ? 0.012
                      : 0.988 - s.errorRatio);
                break;
              case "http_request_duration_seconds_bucket":
                value =
                  s.rpm *
                  (variant === "+Inf"
                    ? 1
                    : 1 - Math.exp(-Number(variant) / s.latency));
                break;
              case "http_request_duration_seconds_sum":
                value = s.rpm * s.latency;
                break;
              case "http_request_duration_seconds_count":
                value = s.rpm;
                break;
              case "cache_hit_ratio":
                value = s.cacheHit;
                break;
              case "worker_queue_depth":
              case "kafka_consumer_lag":
                value = s.lag;
                break;
              case "container_cpu_utilization_ratio":
                value = s.cpu;
                break;
              case "node_disk_utilization_ratio":
                value = s.disk;
                break;
              case "gpu_worker_restarts_per_hour":
                value = s.restarts;
                break;
              case "feed_engagement_ratio":
                value = 0.31 * (1 - s.errorRatio * 4);
                break;
              case "upload_completion_ratio":
                value = 0.995 - s.errorRatio * 4;
                break;
              case "video_rebuffer_ratio":
                value = 0.004 + (1 - s.cacheHit) * 0.18;
                break;
            }
            if (METRICS[name].type === "counter") {
              counter += value;
              return counter;
            }
            return value;
          });
          result.push({ metric, values });
        }
      }
    }
  cachedSeries = result;
  return result;
}
export interface LogRecord {
  timestamp: number;
  labels: Labels;
  fields: Record<string, string | number | boolean>;
}
let cachedLogs: LogRecord[] | undefined;
export function logs(): LogRecord[] {
  if (cachedLogs) return cachedLogs;
  cachedLogs = Array.from({ length: 120000 }, (_, n) => {
    const timestamp = START + Math.floor((n / 120000) * (END - START));
    const service =
      SERVICES[Math.floor(hash(`service:${n}`) * SERVICES.length)]!;
    const region = REGIONS[Math.floor(hash(`region:${n}`) * REGIONS.length)]!;
    const s = signals(service, region, timestamp);
    // Errors are sampled ten times as often as successes, as in an error-biased log pipeline.
    const failed =
      hash(`failure:${n}`) < (10 * s.errorRatio) / (1 + 9 * s.errorRatio);
    const warn = !failed && !!s.incident && hash(`warn:${n}`) < 0.35;
    const level = failed ? "error" : warn ? "warn" : "info";
    const symptoms: Record<string, string> = {
      "redis-feed": "connection pool exhausted; cache lookup timed out",
      ranking:
        "cache miss for namespace feed:v218; fallback ranking exceeded deadline",
      "feed-api": "ranking RPC exceeded 1200ms deadline; serving stale feed",
      "api-gateway": "GET /v1/feed upstream deadline exceeded",
      transcoder:
        "CUDA out of memory while decoding HEVC; job returned to queue",
      "media-api": "upload accepted; transcoding pending beyond 300s SLO",
      kafka: "broker-2 disk utilization 96%; under-replicated partitions=18",
      messaging: "message persisted; delivery acknowledgement delayed",
      notifications: "push delivery delayed by consumer backlog",
      "cdn-edge": "edge-route-884 origin=us-west-2 cache=MISS pop=SIN",
      "reels-api": "segment fetch slow; player rebuffer threshold exceeded",
    };
    const traceId =
      Math.floor(hash(`trace:${n}`) * 2 ** 32)
        .toString(16)
        .padStart(8, "0") + n.toString(16).padStart(24, "0");
    return {
      timestamp,
      labels: {
        service: service.name,
        region,
        environment: "production",
        level,
        cluster: `instapix-${region}`,
      },
      fields: {
        synthetic: true,
        message:
          (failed || warn) && s.incident
            ? symptoms[service.name]!
            : failed
              ? "upstream transient failure; retry budget exhausted"
              : "request completed",
        trace_id: traceId,
        span_id: n.toString(16).padStart(16, "0"),
        request_id: `req-${n.toString(36)}`,
        duration_ms: Math.round(
          s.latency * 1000 * (0.5 + hash(`latency:${n}`) * 2),
        ),
        status: failed ? 503 : 200,
        version: s.version,
        pod: `${service.name}-${region}-${n % 4}`,
        user_id: `synthetic-user-${Math.floor(hash(`user:${n}`) * 48000)}`,
        platform: ["ios", "android", "web"][n % 3]!,
        dependency: service.dependency,
        sample_rate: failed ? 0.01 : 0.001,
      },
    };
  });
  return cachedLogs;
}
export function annotations() {
  return INCIDENTS.flatMap((i, n) => [
    {
      id: n * 2 + 1,
      time: i.start,
      timeEnd: i.start,
      tags: ["deployment", i.region, i.root],
      text: `${i.root}: ${n === 0 ? "deploy v2.18.0" : n === 1 ? "deploy v3.8.1" : n === 2 ? "broker disk capacity warning" : "apply edge-route-884"}`,
    },
    ...(i.end <= END
      ? [
          {
            id: n * 2 + 2,
            time: i.end,
            timeEnd: i.end,
            tags: ["mitigation", i.region, i.root],
            text: i.mitigation,
          },
        ]
      : []),
  ]);
}
