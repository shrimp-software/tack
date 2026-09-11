import { createHash } from "node:crypto";

export class ResponseSerializationError extends Error {
  readonly code: string;
  constructor(message: string, code = "response_unserializable") { super(message); this.name = "ResponseSerializationError"; this.code = code; }
}

function ownData(value: object, key: string): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new ResponseSerializationError("response contains an accessor or missing own property");
  return descriptor;
}

/**
 * Serializes without JSON.stringify: this means neither toJSON nor a getter can
 * run while a retained response is being inspected. Object keys are sorted to
 * make persisted bytes deterministic and all unsupported values are rejected.
 */
export function serializeJson(value: unknown, limits: { readonly maxDepth?: number; readonly maxNodes?: number; readonly maxBytes?: number } = {}): string {
  const maxDepth = limits.maxDepth ?? 64;
  const maxNodes = limits.maxNodes ?? 1_000_000;
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const charge = (count: number): void => {
    bytes += count;
    if (limits.maxBytes !== undefined && bytes > limits.maxBytes) throw new ResponseSerializationError("response exceeds the configured byte cap", "response_too_large");
  };
  const primitive = (value: string): string => { charge(Buffer.byteLength(value, "utf8")); return value; };
  function encode(input: unknown, depth: number): string {
    nodes += 1;
    if (depth > maxDepth) throw new ResponseSerializationError("response_json_depth_exceeded");
    if (nodes > maxNodes) throw new ResponseSerializationError("response_json_node_limit_exceeded");
    if (input === null) return primitive("null");
    switch (typeof input) {
      case "string": {
        if (limits.maxBytes !== undefined && Buffer.byteLength(input, "utf8") > limits.maxBytes - bytes) throw new ResponseSerializationError("response exceeds the configured byte cap", "response_too_large");
        return primitive(JSON.stringify(input));
      }
      case "boolean": return primitive(input ? "true" : "false");
      case "number": {
        if (!Number.isFinite(input)) throw new ResponseSerializationError("response_nonfinite_number");
        return primitive(JSON.stringify(input));
      }
      case "undefined": throw new ResponseSerializationError("response_undefined_value");
      case "bigint": throw new ResponseSerializationError("response_bigint_value");
      case "function": throw new ResponseSerializationError("response_function_value");
      case "symbol": throw new ResponseSerializationError("response_symbol_value");
      case "object": {
        if (seen.has(input)) throw new ResponseSerializationError("response_cyclic_value");
        const prototype = Object.getPrototypeOf(input);
        if (Array.isArray(input)) {
          seen.add(input);
          charge(2 + Math.max(0, input.length - 1));
          const values: string[] = [];
          for (let index = 0; index < input.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
            if (!descriptor || !("value" in descriptor)) throw new ResponseSerializationError("response_sparse_array");
            values.push(encode(descriptor.value, depth + 1));
          }
          seen.delete(input);
          return `[${values.join(",")}]`;
        }
        if (prototype !== Object.prototype && prototype !== null) throw new ResponseSerializationError("response_class_instance");
        seen.add(input);
        const keys = Object.keys(input).sort();
        charge(2 + Math.max(0, keys.length - 1));
        const values = keys.map((key) => { const encodedKey = JSON.stringify(key); charge(Buffer.byteLength(encodedKey, "utf8") + 1); return `${encodedKey}:${encode(ownData(input, key).value, depth + 1)}`; });
        seen.delete(input);
        return `{${values.join(",")}}`;
      }
      default: throw new ResponseSerializationError("response_unsupported_value");
    }
  }
  return encode(value, 0);
}

export interface NormalizedResponseEnvelope {
  readonly formatVersion: 1;
  readonly kind: "tool-response" | "derived-result";
  readonly upstreamOutcome?: "not_started" | "succeeded" | "failed" | "unknown";
  readonly data?: unknown;
  readonly text: string;
  readonly raw?: unknown;
  readonly provenance?: unknown;
}

export interface SerializedEnvelope {
  readonly text: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly rootShape: "object" | "array" | "string" | "number" | "boolean" | "null" | "unknown";
  readonly normalized: NormalizedResponseEnvelope;
}

export function serializeNormalizedEnvelope(envelope: NormalizedResponseEnvelope, limits: { readonly maxBytes?: number; readonly maxDepth?: number; readonly maxNodes?: number } = {}): SerializedEnvelope {
  const normalized = normalizeEnvelope(envelope);
  const text = serializeJson(normalized, limits);
  const bytes = Buffer.byteLength(text, "utf8");
  if (limits.maxBytes !== undefined && bytes > limits.maxBytes) throw new ResponseSerializationError("response exceeds the configured byte cap", "response_too_large");
  return { text, bytes, sha256: createHash("sha256").update(text, "utf8").digest("hex"), rootShape: shapeOf(normalized.data), normalized };
}

function normalizeEnvelope(envelope: NormalizedResponseEnvelope): NormalizedResponseEnvelope {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope) || (Object.getPrototypeOf(envelope) !== Object.prototype && Object.getPrototypeOf(envelope) !== null)) throw new ResponseSerializationError("response_envelope_not_object");
  const formatVersion = ownData(envelope, "formatVersion").value;
  const kind = ownData(envelope, "kind").value;
  const text = ownData(envelope, "text").value;
  const upstreamOutcome = Object.getOwnPropertyDescriptor(envelope, "upstreamOutcome");
  const data = Object.getOwnPropertyDescriptor(envelope, "data");
  const raw = Object.getOwnPropertyDescriptor(envelope, "raw");
  const provenance = Object.getOwnPropertyDescriptor(envelope, "provenance");
  if (provenance && !("value" in provenance)) throw new ResponseSerializationError("response_accessor");
  if (formatVersion !== 1 || (kind !== "tool-response" && kind !== "derived-result")) throw new ResponseSerializationError("response_envelope_version_unsupported");
  if (typeof text !== "string") throw new ResponseSerializationError("response_text_not_string");
  if (kind === "tool-response" && (!upstreamOutcome || !("value" in upstreamOutcome) || upstreamOutcome.value === undefined)) throw new ResponseSerializationError("response_upstream_outcome_missing");
  if (upstreamOutcome && !("value" in upstreamOutcome)) throw new ResponseSerializationError("response contains an accessor or missing own property");
  if (data && !("value" in data)) throw new ResponseSerializationError("response contains an accessor or missing own property");
  if (raw && !("value" in raw)) throw new ResponseSerializationError("response contains an accessor or missing own property");
  return { formatVersion: 1, kind, text, ...(provenance ? { provenance: provenance.value } : {}), ...(upstreamOutcome && upstreamOutcome.value !== undefined ? { upstreamOutcome: upstreamOutcome.value } : {}), ...(data ? { data: data.value } : {}), ...(raw ? { raw: raw.value } : {}) } as NormalizedResponseEnvelope;
}

export function shapeOf(value: unknown): SerializedEnvelope["rootShape"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    case "object": return "object";
    default: return "unknown";
  }
}

function shapeNode(value: unknown, depth: number, maxDepth: number): unknown {
  const type = shapeOf(value);
  if (depth >= maxDepth || value === null || typeof value !== "object") return { type };
  if (Array.isArray(value)) return { type, length: value.length };
  const keys = Object.keys(value).sort();
  return { type, keys };
}

/** Builds a value-free preview and never allows it to exceed the preview cap. */
export function makeShapePreview(value: unknown, maxBytes = 2 * 1024): unknown {
  const candidates: unknown[] = [shapeNode(value, 0, 1), { type: shapeOf(value) }, undefined];
  for (const candidate of candidates) {
    if (candidate === undefined) return undefined;
    try {
      const encoded = serializeJson(candidate, { maxDepth: 4, maxNodes: 10_000 });
      if (Buffer.byteLength(encoded, "utf8") <= maxBytes) return candidate;
    } catch { /* move to the smaller shape */ }
  }
  return undefined;
}
