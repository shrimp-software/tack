/**
 * A compact, type-only structural skeleton of a value — attached to every
 * successful downstream result as `dataShape` so a cell can see a response's
 * layout without guessing property paths. Bounded in depth and total size;
 * carries types, not values. The in-sandbox `shape(value, maxDepth?)` prelude
 * helper (see `tools.ts`) is the same algorithm with a deeper default and a
 * larger budget — keep the two in sync.
 */
export function describeShape(value: unknown, maxDepth = 3, budget = 400): unknown {
  const walk = (v: unknown, depth: number): unknown => {
    if (budget <= 0) return "…";
    if (v === null) return "null";
    const t = typeof v;
    if (t !== "object") {
      budget -= 6;
      return t;
    }
    if (Array.isArray(v)) {
      budget -= 8;
      if (v.length === 0) return "array(0)";
      if (depth <= 0) return `array(${v.length})`;
      return { array: v.length, of: walk(v[0], depth - 1) };
    }
    const record = v as Record<string, unknown>;
    const keys = Object.keys(record);
    budget -= 4 + keys.length * 3;
    if (depth <= 0) {
      return `object{${keys.slice(0, 12).join(",")}${keys.length > 12 ? ",…" : ""}}`;
    }
    const out: Record<string, unknown> = {};
    for (const key of keys.slice(0, 24)) out[key] = walk(record[key], depth - 1);
    if (keys.length > 24) out["…"] = `${keys.length - 24} more`;
    return out;
  };
  try {
    return walk(value, maxDepth);
  } catch {
    return "unknown";
  }
}
