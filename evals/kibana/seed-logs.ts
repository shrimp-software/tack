#!/usr/bin/env bun
const elasticsearchUrl = env("ELASTICSEARCH_URL", "http://localhost:9200");
const indexName = env("KIBANA_EVAL_INDEX", "tack-eval-logs");
const logCount = numberEnv("KIBANA_EVAL_LOG_COUNT", 50_000);
const batchSize = numberEnv("KIBANA_EVAL_BATCH_SIZE", 1_000);

const services = ["checkout", "payments", "auth", "search", "inventory", "gateway"];
const hosts = ["api-1", "api-2", "worker-1", "worker-2", "edge-1"];
const datasets = ["app.log", "nginx.access", "worker.job"];
const now = Date.now();

await ensureIndex();
for (let offset = 0; offset < logCount; offset += batchSize) {
  const count = Math.min(batchSize, logCount - offset);
  await bulkInsert(offset, count);
  console.log(`seeded ${offset + count}/${logCount}`);
}
await request(`/${encodeURIComponent(indexName)}/_refresh`, { method: "POST" });
console.log(`seeded ${logCount} logs into ${indexName}`);

async function ensureIndex(): Promise<void> {
  const exists = await request(`/${encodeURIComponent(indexName)}`, { method: "HEAD", okStatuses: [200, 404] });
  if (exists.status === 200) {
    return;
  }

  await request(`/${encodeURIComponent(indexName)}`, {
    method: "PUT",
    body: JSON.stringify({
      mappings: {
        dynamic: true,
        properties: {
          "@timestamp": { type: "date" },
          "service.name": { type: "keyword" },
          "log.level": { type: "keyword" },
          message: { type: "text" },
          "trace.id": { type: "keyword" },
          "host.name": { type: "keyword" },
          "event.dataset": { type: "keyword" },
          "http.response.status_code": { type: "integer" },
          duration_ms: { type: "integer" },
          "user.id": { type: "keyword" },
          "client.ip": { type: "ip" },
          "kibana.eval.scenario": { type: "keyword" }
        }
      }
    })
  });
}

async function bulkInsert(offset: number, count: number): Promise<void> {
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const sequence = offset + index;
    lines.push(JSON.stringify({ index: { _index: indexName, _id: `seed-${sequence}` } }));
    lines.push(JSON.stringify(logEvent(sequence)));
  }

  await request("/_bulk", {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: `${lines.join("\n")}\n`
  });
}

function logEvent(sequence: number): Record<string, unknown> {
  const minute = sequence % (24 * 60);
  const service = services[sequence % services.length] ?? "checkout";
  const spike = anomaly(sequence, service, minute);
  const level = spike.level ?? weightedLevel(sequence);
  const statusCode = spike.statusCode ?? statusForLevel(level, sequence);
  const durationMs = spike.durationMs ?? baselineDuration(sequence, service);

  return {
    "@timestamp": new Date(now - (24 * 60 - minute) * 60_000 - (sequence % 60) * 1_000).toISOString(),
    "service.name": service,
    "log.level": level,
    message: spike.message ?? messageFor(service, level, statusCode),
    "trace.id": `trace-${Math.floor(sequence / 5).toString(16).padStart(8, "0")}`,
    "host.name": hosts[sequence % hosts.length],
    "event.dataset": datasets[sequence % datasets.length],
    "http.response.status_code": statusCode,
    duration_ms: durationMs,
    "user.id": `user-${sequence % 4000}`,
    "client.ip": `10.${(sequence >> 16) & 255}.${(sequence >> 8) & 255}.${sequence & 255}`,
    "kibana.eval.scenario": spike.scenario ?? "baseline"
  };
}

function anomaly(
  sequence: number,
  service: string,
  minute: number
): {
  readonly level?: string;
  readonly statusCode?: number;
  readonly durationMs?: number;
  readonly message?: string;
  readonly scenario?: string;
} {
  if (service === "payments" && minute >= 690 && minute <= 735) {
    return {
      level: sequence % 3 === 0 ? "error" : "warn",
      statusCode: sequence % 4 === 0 ? 503 : 500,
      durationMs: 1800 + (sequence % 900),
      message: "payment provider timeout after retry budget exhausted",
      scenario: "payments-outage"
    };
  }

  if (service === "checkout" && minute >= 925 && minute <= 960) {
    return {
      level: "warn",
      statusCode: 200,
      durationMs: 2400 + (sequence % 1200),
      message: "checkout latency above p95 budget",
      scenario: "checkout-latency"
    };
  }

  if (service === "auth" && minute >= 1200 && minute <= 1245) {
    return {
      level: sequence % 2 === 0 ? "error" : "warn",
      statusCode: 401,
      durationMs: 80 + (sequence % 60),
      message: "failed login burst from repeated client fingerprints",
      scenario: "auth-failure-burst"
    };
  }

  if (service === "search" && sequence % 997 === 0) {
    return {
      level: "error",
      statusCode: 504,
      durationMs: 5200,
      message: "search shard timeout while expanding query",
      scenario: "search-timeout"
    };
  }

  return {};
}

function weightedLevel(sequence: number): string {
  if (sequence % 89 === 0) {
    return "error";
  }
  if (sequence % 17 === 0) {
    return "warn";
  }
  return "info";
}

function statusForLevel(level: string, sequence: number): number {
  if (level === "error") {
    return sequence % 2 === 0 ? 500 : 502;
  }
  if (level === "warn") {
    return sequence % 5 === 0 ? 429 : 200;
  }
  return 200;
}

function baselineDuration(sequence: number, service: string): number {
  const base = service === "search" ? 180 : service === "checkout" ? 260 : 120;
  return base + (sequence % 130);
}

function messageFor(service: string, level: string, statusCode: number): string {
  if (level === "error") {
    return `${service} request failed with status ${statusCode}`;
  }
  if (level === "warn") {
    return `${service} request nearing service budget`;
  }
  return `${service} request completed`;
}

async function request(
  path: string,
  init: RequestInit & { readonly okStatuses?: readonly number[] } = {}
): Promise<Response> {
  const url = new URL(path, elasticsearchUrl);
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(authHeaders())) {
    headers.set(key, value);
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(url, { ...init, headers });
  const okStatuses = init.okStatuses ?? [200, 201];
  if (!okStatuses.includes(response.status)) {
    const text = await response.text();
    throw new Error(`${init.method ?? "GET"} ${url.href} failed: ${response.status} ${text}`);
  }
  return response;
}

function authHeaders(): Record<string, string> {
  const apiKey = process.env.ELASTIC_API_KEY;
  if (apiKey) {
    return { authorization: `ApiKey ${apiKey}` };
  }

  const username = process.env.ELASTIC_USERNAME;
  const password = process.env.ELASTIC_PASSWORD;
  if (username && password) {
    return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
  }

  return {};
}

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
