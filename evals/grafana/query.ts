import {
  END,
  START,
  MINUTE,
  METRICS,
  metricSeries,
  logs,
  type Labels,
  type MetricName,
} from "./world.js";

export function time(value: string): number {
  if (value === "now") return END;
  const relative = /^now-(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(value);
  if (relative)
    return (
      END -
      Number(relative[1]) *
        { s: 1000, m: MINUTE, h: 60 * MINUTE, d: 1440 * MINUTE }[relative[2]!]!
    );
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(
      `Invalid time: ${value}. Use RFC3339 or now-30m; mock now=${new Date(END).toISOString()}`,
    );
  return parsed;
}
export function matchers(source: string): (labels: Labels) => boolean {
  const tests: ((labels: Labels) => boolean)[] = [];
  let rest = source.trim();
  while (rest) {
    const match =
      /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*("(?:[^"\\]|\\.)*")\s*(,\s*|$)/.exec(
        rest,
      );
    if (!match) throw new Error(`Invalid label matchers: ${source}`);
    const [, key, operator, quoted] = match;
    const value = JSON.parse(quoted!) as string;
    const regex = operator!.includes("~")
      ? new RegExp(`^(?:${value})$`)
      : undefined;
    tests.push((labels) => {
      const actual = labels[key!] ?? "";
      const equal = regex ? regex.test(actual) : actual === value;
      return operator!.startsWith("!") ? !equal : equal;
    });
    rest = rest.slice(match[0].length);
  }
  return (labels) => tests.every((test) => test(labels));
}
export type Vector = { metric: Labels; value: number }[];
type Expression = (at: number) => Vector;

/** Explicit, composable PromQL subset. Unknown syntax is rejected, never guessed. */
export function compile(expr: string): Expression {
  expr = expr.trim();
  if (!expr || expr.length > 4000)
    throw new Error("PromQL expression must contain 1..4000 characters");
  const aggregate =
    /^(sum|avg|max|min)\s*(?:by\s*\(([^)]*)\))?\s*\(([\s\S]*)\)$/.exec(expr);
  if (aggregate && balanced(aggregate[3]!)) {
    const inner = compile(aggregate[3]!);
    const keys =
      aggregate[2]
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    if (keys.some((k) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)))
      throw new Error("Invalid grouping label");
    return (at) => {
      const groups = new Map<string, { metric: Labels; values: number[] }>();
      for (const row of inner(at)) {
        const metric = Object.fromEntries(
          keys.filter((k) => k in row.metric).map((k) => [k, row.metric[k]!]),
        );
        const key = JSON.stringify(metric);
        const group = groups.get(key) ?? { metric, values: [] };
        group.values.push(row.value);
        groups.set(key, group);
      }
      return [...groups.values()].map(({ metric, values }) => ({
        metric,
        value:
          aggregate[1] === "max"
            ? Math.max(...values)
            : aggregate[1] === "min"
              ? Math.min(...values)
              : values.reduce((a, b) => a + b, 0) /
                (aggregate[1] === "avg" ? values.length : 1),
      }));
    };
  }
  const quantile =
    /^histogram_quantile\((0(?:\.\d+)?|1(?:\.0+)?),\s*([\s\S]*)\)$/.exec(expr);
  if (quantile && balanced(quantile[2]!)) {
    const inner = compile(quantile[2]!);
    const q = Number(quantile[1]);
    return (at) => {
      const groups = new Map<
        string,
        { metric: Labels; buckets: [number, number][] }
      >();
      for (const row of inner(at)) {
        if (!("le" in row.metric))
          throw new Error("histogram_quantile requires buckets grouped by le");
        const { le, __name__, ...metric } = row.metric;
        const key = JSON.stringify(metric);
        const group = groups.get(key) ?? { metric, buckets: [] };
        group.buckets.push([le === "+Inf" ? Infinity : Number(le), row.value]);
        groups.set(key, group);
      }
      return [...groups.values()].map(({ metric, buckets }) => {
        buckets.sort((a, b) => a[0] - b[0]);
        const total = buckets.at(-1)!;
        if (total[0] !== Infinity)
          throw new Error("Histogram needs +Inf bucket");
        const rank = total[1] * q;
        let lower = 0;
        let count = 0;
        for (const [upper, next] of buckets) {
          if (next >= rank)
            return {
              metric,
              value:
                upper === Infinity
                  ? lower
                  : lower +
                    ((upper - lower) * (rank - count)) /
                      Math.max(next - count, Number.EPSILON),
            };
          lower = upper;
          count = next;
        }
        return { metric, value: NaN };
      });
    };
  }
  // Binary arithmetic with normal precedence; label-identical vector matching.
  for (const operators of [
    ["+", "-"],
    ["*", "/"],
  ]) {
    const position = topLevelOperator(expr, operators);
    if (position > 0) {
      const leftText = expr.slice(0, position).trim();
      const rightText = expr.slice(position + 1).trim();
      const scalar = /^\d+(?:\.\d+)?$/;
      const leftScalar = scalar.test(leftText) ? Number(leftText) : undefined;
      const rightScalar = scalar.test(rightText)
        ? Number(rightText)
        : undefined;
      const left = leftScalar === undefined ? compile(leftText) : undefined;
      const right = rightScalar === undefined ? compile(rightText) : undefined;
      return (at) => {
        const l = left?.(at);
        const r = right?.(at);
        const op = (a: number, b: number) =>
          expr[position] === "/"
            ? a / b
            : expr[position] === "*"
              ? a * b
              : expr[position] === "+"
                ? a + b
                : a - b;
        const key = (labels: Labels) =>
          JSON.stringify(
            Object.entries(labels)
              .filter(([k]) => k !== "__name__")
              .sort(([a], [b]) => a.localeCompare(b)),
          );
        const clean = (labels: Labels) =>
          Object.fromEntries(
            Object.entries(labels).filter(([k]) => k !== "__name__"),
          );
        if (leftScalar !== undefined && rightScalar !== undefined)
          return [{ metric: {}, value: op(leftScalar, rightScalar) }];
        if (leftScalar !== undefined)
          return r!.map((row) => ({
            metric: clean(row.metric),
            value: op(leftScalar, row.value),
          }));
        if (rightScalar !== undefined)
          return l!.map((row) => ({
            metric: clean(row.metric),
            value: op(row.value, rightScalar),
          }));
        const index = new Map(r!.map((row) => [key(row.metric), row.value]));
        return l!.flatMap((row) =>
          index.has(key(row.metric))
            ? [
                {
                  metric: clean(row.metric),
                  value: op(row.value, index.get(key(row.metric))!),
                },
              ]
            : [],
        );
      };
    }
  }
  if (expr.startsWith("(") && expr.endsWith(")") && balanced(expr.slice(1, -1)))
    return compile(expr.slice(1, -1));
  const rate =
    /^(rate|increase)\(([a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^}]*\})?)\[(\d+)(m|h)\]\)$/.exec(
      expr,
    );
  const selectorText = rate ? rate[2]! : expr;
  const selector = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?$/.exec(
    selectorText,
  );
  if (!selector)
    throw new Error(
      "Unsupported mock PromQL. Supported: selectors, rate/increase [Nm|Nh], sum/avg/min/max by (...), histogram_quantile, arithmetic. Use dashboard queries as examples.",
    );
  const name = selector[1]!;
  const matches = matchers(selector[2] ?? "");
  if (rate && name in METRICS && METRICS[name as MetricName].type !== "counter")
    throw new Error(`rate/increase requires a counter: ${name}`);
  const series = metricSeries().filter(
    (s) => s.metric.__name__ === name && matches(s.metric),
  );
  const minutes = rate ? Number(rate[3]) * (rate[4] === "h" ? 60 : 1) : 0;
  if (rate && (minutes < 1 || minutes > 2880))
    throw new Error("Rate window must be 1m..48h");
  return (at) => {
    if (at < START || at > END) return [];
    const minute = Math.floor((at - START) / MINUTE);
    if (rate && minute < minutes) return [];
    return series.map((s) => {
      const { __name__, ...labels } = s.metric;
      return {
        metric: rate ? labels : s.metric,
        value: rate
          ? (s.values[minute]! - s.values[minute - minutes]!) /
            (rate[1] === "rate" ? minutes * 60 : 1)
          : s.values[minute]!,
      };
    });
  };
}
function balanced(text: string): boolean {
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (const c of text) {
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') quote = true;
    if (c === "(") depth++;
    if (c === ")" && --depth < 0) return false;
  }
  return depth === 0 && !quote;
}
function topLevelOperator(text: string, operators: string[]): number {
  let depth = 0;
  let quote = false;
  let escaped = false;
  let result = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') quote = true;
    else if ("({[".includes(c)) depth++;
    else if (")}]".includes(c)) depth--;
    else if (depth === 0 && operators.includes(c)) result = i;
  }
  return result;
}
export function queryPrometheus(args: {
  expr: string;
  endTime: string;
  queryType?: string | undefined;
  startTime?: string | undefined;
  stepSeconds?: number | undefined;
}) {
  const evaluate = compile(args.expr);
  const end = time(args.endTime);
  if (args.queryType === "instant")
    return {
      data: evaluate(end).map((row) => ({
        metric: row.metric,
        value: [end / 1000, String(row.value)],
      })),
    };
  if (args.queryType && args.queryType !== "range")
    throw new Error("queryType must be instant or range");
  if (!args.startTime || !args.stepSeconds || args.stepSeconds < 60)
    throw new Error(
      "Range queries require startTime and stepSeconds >= 60 (mock resolution)",
    );
  const start = time(args.startTime);
  if (start > end || (end - start) / (args.stepSeconds * 1000) > 2880)
    throw new Error("Invalid range or more than 2881 steps");
  const output = new Map<
    string,
    { metric: Labels; values: [number, string][] }
  >();
  let samples = 0;
  for (let at = start; at <= end; at += args.stepSeconds * 1000)
    for (const row of evaluate(at)) {
      if (++samples > 100000)
        throw new Error(
          "Query exceeds 100000 samples; aggregate, filter labels or increase stepSeconds",
        );
      const key = JSON.stringify(row.metric);
      const entry = output.get(key) ?? { metric: row.metric, values: [] };
      entry.values.push([at / 1000, String(row.value)]);
      output.set(key, entry);
    }
  return { data: [...output.values()] };
}
export function queryLogs(args: {
  logql: string;
  startRfc3339?: string | undefined;
  endRfc3339?: string | undefined;
  limit?: number | undefined;
  direction?: string | undefined;
}) {
  const start = time(args.startRfc3339 ?? "now-1h");
  const end = time(args.endRfc3339 ?? "now");
  if (start > end) throw new Error("Start must precede end");
  const selector = /^\s*\{([^}]*)\}([\s\S]*)$/.exec(args.logql);
  if (!selector)
    throw new Error(
      "Supported mock LogQL: {label matchers} with |=, !=, |~, !~ line filters, | json, and JSON field equality filters",
    );
  const matches = matchers(selector[1]!);
  const filters: ((
    line: string,
    fields: Record<string, unknown>,
  ) => boolean)[] = [];
  let rest = selector[2]!.trim();
  let parsedJson = false;
  while (rest) {
    const json = /^\|\s*json\b/.exec(rest);
    if (json) {
      parsedJson = true;
      rest = rest.slice(json[0].length).trim();
      continue;
    }
    const field =
      /^\|\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*("(?:[^"\\]|\\.)*")/.exec(
        rest,
      );
    if (field && parsedJson) {
      const matcher = matchers(`${field[1]}${field[2]}${field[3]}`);
      filters.push((_, fields) =>
        matcher(
          Object.fromEntries(
            Object.entries(fields).map(([k, v]) => [k, String(v)]),
          ),
        ),
      );
      rest = rest.slice(field[0].length).trim();
      continue;
    }
    const line = /^(\|=|!=|\|~|!~)\s*("(?:[^"\\]|\\.)*")/.exec(rest);
    if (!line) throw new Error(`Unsupported mock LogQL pipeline: ${rest}`);
    const value = JSON.parse(line[2]!) as string;
    const regex = line[1]!.includes("~") ? new RegExp(value) : undefined;
    filters.push(
      (text) =>
        (regex ? regex.test(text) : text.includes(value)) !==
        line[1]!.startsWith("!"),
    );
    rest = rest.slice(line[0].length).trim();
  }
  const selected = logs().filter(
    (log) =>
      log.timestamp >= start &&
      log.timestamp <= end &&
      matches(log.labels) &&
      filters.every((filter) => filter(JSON.stringify(log.fields), log.fields)),
  );
  if (args.direction !== "forward") selected.reverse();
  const limit = args.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("limit must be 1..1000");
  return {
    streams: selected
      .slice(0, limit)
      .map((log) => ({
        labels: log.labels,
        timestamp: `${BigInt(log.timestamp) * 1000000n}`,
        line: JSON.stringify(log.fields),
      })),
    totalMatching: selected.length,
    truncated: selected.length > limit,
  };
}
