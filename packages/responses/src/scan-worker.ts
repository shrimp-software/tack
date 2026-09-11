import { createHash } from "node:crypto";
import {
  validateScanCoverage,
  validateScanSpec,
  type ScanCoverage,
  type ScanSpec,
} from "@cbxss/tack-core";
import {
  checkShape,
  selectPointer,
  readBoundedStoredFile,
} from "./read-worker.js";
import { serializeJson } from "./serialization.js";
export interface ScanWorkerInput {
  path: string;
  sha256: string;
  pointer: string;
  spec: ScanSpec;
  offset: number;
  limit: number;
  maxBytes: number;
  stopReason: "output_limit" | "artifact_limit";
  deadlineAtMs: number;
}
export interface ScanWorkerResult {
  data: unknown;
  numericCount: number;
  coverage: ScanCoverage;
}
const absent = Symbol("absent");
function field(row: unknown, pointer: string): unknown {
  try {
    return selectPointer(row, pointer);
  } catch {
    return absent;
  }
}

/** Trusted worker entrypoint. No agent code, dynamic imports or callbacks. */
export async function scanResponse(
  input: ScanWorkerInput,
): Promise<ScanWorkerResult> {
  const spec = validateScanSpec(input.spec);
  const bytes = await readBoundedStoredFile(input.path);
  if (
    bytes.byteLength > 32 * 1024 * 1024 ||
    createHash("sha256").update(bytes).digest("hex") !== input.sha256
  )
    throw new Error("response_corrupt");
  const root: unknown = JSON.parse(bytes.toString("utf8"));
  checkShape(root, 64, 1_000_000);
  const selected = selectPointer(root, input.pointer);
  if (!Array.isArray(selected)) throw new Error("scan_array_required");
  const rows: unknown[] = [];
  const groups = new Map<string, { key: unknown; count: number; numericCount: number; aggregate: number }>();
  let scanned = 0,
    matched = 0,
    skippedTypeCount = 0,
    numericCount = 0,
    aggregate = 0,
    outputBytes = 2;
  let stopReason: ScanCoverage["stopReason"] = null;
  while (input.offset + scanned < selected.length) {
    if (scanned >= input.limit) {
      stopReason = "record_limit";
      break;
    }
    if (Date.now() >= input.deadlineAtMs) {
      if (!scanned) throw new Error("scan_timeout");
      stopReason = "deadline";
      break;
    }
    const row = selected[input.offset + scanned];
    let match = true,
      skipped = false;
    for (const filter of spec.where ?? []) {
      const value = field(row, filter.pointer);
      if (
        value === null ||
        filter.value === null ||
        !["string", "number", "boolean"].includes(typeof value) ||
        typeof value !== typeof filter.value ||
        (!["eq", "ne"].includes(filter.op) && typeof value === "boolean")
      ) {
        skipped = true;
        match = false;
        break;
      }
      const left = value as string | number,
        right = filter.value as string | number;
      const passes =
        filter.op === "eq"
          ? value === filter.value
          : filter.op === "ne"
            ? value !== filter.value
            : filter.op === "lt"
              ? left < right
              : filter.op === "lte"
                ? left <= right
                : filter.op === "gt"
                  ? left > right
                  : left >= right;
      if (!passes) {
        match = false;
        break;
      }
    }
    let projected: unknown = row;
    let numberValue: number | undefined;
    if (match && ["sum", "min", "max", "mean"].includes(spec.operation)) {
      let value = field(row, spec.value!);
      if (spec.numericStrings && typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value)) value = Number(value);
      if (typeof value !== "number" || !Number.isFinite(value)) {
        skipped = true;
      } else numberValue = value;
    }
    let group: { key: unknown; count: number; numericCount: number; aggregate: number } | undefined;
    if (match && spec.groupBy !== undefined) {
      const key = field(row, spec.groupBy);
      if (key === absent || (key !== null && !["string", "number", "boolean"].includes(typeof key))) { skipped = true; match = false; }
      else {
        const encoded = JSON.stringify(key);
        group = groups.get(encoded);
        if (!group) {
          if (groups.size >= (spec.maxGroups ?? 100)) { stopReason = "group_limit"; break; }
          group = { key, count: 0, numericCount: 0, aggregate: 0 };
          groups.set(encoded, group);
        }
      }
    }
    if (match && spec.operation === "rows") {
      if (spec.select) {
        const object: Record<string, unknown> = Object.create(null);
        for (const projection of spec.select) {
          const value = field(row, projection.pointer);
          if (value !== absent) object[projection.name] = value;
        }
        projected = object;
      }
      let size: number;
      try {
        size =
          Buffer.byteLength(
            serializeJson(projected, { maxBytes: input.maxBytes + 1 }),
          ) + (rows.length ? 1 : 0);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "response_too_large"
        )
          size = input.maxBytes + 1;
        else throw error;
      }
      if (outputBytes + size > input.maxBytes) {
        if (scanned === 0) throw new Error("response_element_too_large");
        stopReason = input.stopReason;
        break;
      }
      rows.push(projected);
      outputBytes += size;
    }
    scanned++;
    if (skipped) skippedTypeCount++;
    if (!match) continue;
    matched++;
    if (group) group.count++;
    if (numberValue !== undefined) {
      aggregate =
        (spec.operation === "sum" || spec.operation === "mean")
          ? aggregate + numberValue
          : numericCount === 0
            ? numberValue
            : spec.operation === "min"
              ? Math.min(aggregate, numberValue)
              : Math.max(aggregate, numberValue);
      if (group) {
        group.aggregate = spec.operation === "sum" || spec.operation === "mean" ? group.aggregate + numberValue : group.numericCount === 0 ? numberValue : spec.operation === "min" ? Math.min(group.aggregate, numberValue) : Math.max(group.aggregate, numberValue);
        group.numericCount++;
        if (!Number.isFinite(group.aggregate)) throw new Error("scan_numeric_overflow");
      }
      numericCount++;
      if (!Number.isFinite(aggregate)) throw new Error("scan_numeric_overflow");
    }
  }
  const hasMore = input.offset + scanned < selected.length;
  const coverage: ScanCoverage = {
    offset: input.offset,
    scanned,
    total: selected.length,
    matched,
    skippedTypeCount,
    complete: input.offset === 0 && !hasMore,
    stopReason: hasMore ? stopReason : null,
    nextOffset: hasMore ? input.offset + scanned : null,
  };
  validateScanCoverage(coverage, {
    offset: input.offset,
    sourceTotal: selected.length,
  });
  return {
    data: spec.groupBy !== undefined ? [...groups.values()].map(group => ({ key: group.key, count: group.count, numericCount: group.numericCount, value: spec.operation === "count" ? group.count : spec.operation === "mean" ? (group.numericCount ? group.aggregate / group.numericCount : null) : group.numericCount || spec.operation === "sum" ? group.aggregate : null })) :
      spec.operation === "rows"
        ? rows
        : spec.operation === "count"
          ? matched
          : numericCount === 0 && spec.operation !== "sum"
            ? null
            : spec.operation === "mean" ? aggregate / numericCount : aggregate,
    numericCount,
    coverage,
  };
}
