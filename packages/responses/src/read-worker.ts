import { responseShapeSchema, type ResponseShape } from "@cbxss/tack-core";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { serializeJson, shapeOf } from "./serialization.js";

export interface ReadWorkerInput {
  readonly path: string;
  readonly pointer: string;
  readonly offset: number;
  readonly limit: number;
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly expectedSha256?: string;
}

export interface ReadWorkerPage {
  readonly ok: true;
  readonly pointer: string;
  readonly kind: "array" | "object" | "string" | "scalar";
  readonly value: unknown;
  readonly offset: number;
  readonly returned: number;
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
}

export async function readResponsePage(input: ReadWorkerInput): Promise<ReadWorkerPage | { readonly ok: false; readonly code: string; readonly message: string }> {
  const bytes = await readBoundedStoredFile(input.path);
  if (bytes.byteLength > 32 * 1024 * 1024 + 4096) return { ok: false, code: "response_too_large", message: "stored response exceeds the worker input bound" };
  if (input.expectedSha256 && createHash("sha256").update(bytes).digest("hex") !== input.expectedSha256) return { ok: false, code: "response_corrupt", message: "stored response digest does not match its committed descriptor" };
  let root: unknown;
  try { root = JSON.parse(bytes.toString("utf8")); } catch { return { ok: false, code: "response_corrupt", message: "stored response is not valid JSON" }; }
  try { checkShape(root, input.maxDepth, input.maxNodes); } catch (error) { return { ok: false, code: "response_shape_limit", message: error instanceof Error ? error.message : "stored response shape is too large" }; }
  let selected: unknown;
  try { selected = selectPointer(root, input.pointer); } catch (error) { return { ok: false, code: "response_pointer_invalid", message: error instanceof Error ? error.message : "pointer is invalid" }; }
  const kind = kindOf(selected);
  const source = kind === "object" ? Object.keys(selected as Record<string, unknown>).sort().map((key) => [key, (selected as Record<string, unknown>)[key]]) : selected;
  const total = kind === "array" ? (source as unknown[]).length : kind === "object" ? (source as unknown[]).length : kind === "string" ? Array.from(source as string).length : 1;
  if (kind === "scalar") {
    if (input.offset !== 0) return { ok: false, code: "response_invalid_offset", message: "scalar offsets must be zero" };
    const result = pageEnvelope({ pointer: input.pointer, kind, value: selected, offset: 0, returned: 1, total: 1, hasMore: false, nextOffset: null }, input.maxBytes);
    return result;
  }
  const offset = input.offset;
  if (!Number.isSafeInteger(offset) || offset < 0) return { ok: false, code: "response_invalid_offset", message: "offset must be a non-negative safe integer" };
  if (offset >= total) return pageEnvelope({ pointer: input.pointer, kind, value: kind === "string" ? "" : [], offset, returned: 0, total, hasMore: false, nextOffset: null }, input.maxBytes);
  let count = Math.min(input.limit, total - offset);
  if (!Number.isSafeInteger(count) || count < 1) return { ok: false, code: "response_invalid_limit", message: "limit must be a positive safe integer" };
  while (count > 0) {
    const value = kind === "string" ? Array.from(source as string).slice(offset, offset + count).join("") : (source as unknown[]).slice(offset, offset + count);
    const returned = count;
    const hasMore = offset + returned < total;
    const candidate = { pointer: input.pointer, kind, value, offset, returned, total, hasMore, nextOffset: hasMore ? offset + returned : null } as const;
    const result = pageEnvelope(candidate, input.maxBytes);
    if (result.ok || result.code !== "response_page_too_large") return result;
    count = Math.floor(count / 2);
  }
  return { ok: false, code: "response_element_too_large", message: "one page element cannot fit the bounded read envelope; use a deeper pointer or local export" };
}

function pageEnvelope(candidate: { readonly pointer: string; readonly kind: "array" | "object" | "string" | "scalar"; readonly value: unknown; readonly offset: number; readonly returned: number; readonly total: number; readonly hasMore: boolean; readonly nextOffset: number | null }, maxBytes: number): ReadWorkerPage | { readonly ok: false; readonly code: string; readonly message: string } {
  const page = { ok: true, ...candidate } as const;
  try {
    if (Buffer.byteLength(serializeJson(page, { maxDepth: 64, maxNodes: 1_000_000 }), "utf8") > maxBytes) return { ok: false, code: "response_page_too_large", message: "page exceeds the active byte budget" };
  } catch { return { ok: false, code: "response_element_too_large", message: "page contains an unsupported value" }; }
  return page;
}

function kindOf(value: unknown): "array" | "object" | "string" | "scalar" {
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (value !== null && typeof value === "object") return "object";
  return "scalar";
}

export function selectPointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) throw new Error("RFC6901 pointer must be empty or begin with slash");
  let current = root;
  for (const encoded of pointer.slice(1).split("/")) {
    if (!/^(?:[^~]|~[01])*$/u.test(encoded)) throw new Error("invalid RFC6901 escape");
    const token = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object") throw new Error("pointer path is absent");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(token)) throw new Error("array pointer index is invalid");
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length || !Object.prototype.hasOwnProperty.call(current, token)) throw new Error("pointer path is absent");
      current = current[index];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, token)) throw new Error("pointer path is absent");
      const descriptor = Object.getOwnPropertyDescriptor(current, token);
      if (!descriptor || !("value" in descriptor)) throw new Error("pointer path is not data");
      current = descriptor.value;
    }
  }
  return current;
}

export function checkShape(value: unknown, maxDepth: number, maxNodes: number): void {
  const seen = new Set<object>();
  let nodes = 0;
  function visit(input: unknown, depth: number): void {
    nodes += 1;
    if (depth > maxDepth) throw new Error("json depth exceeds limit");
    if (nodes > maxNodes) throw new Error("json node count exceeds limit");
    if (input === null || typeof input !== "object") return;
    if (seen.has(input)) throw new Error("json cycle");
    seen.add(input);
    if (Array.isArray(input)) for (const item of input) visit(item, depth + 1);
    else for (const key of Object.keys(input)) visit((input as Record<string, unknown>)[key], depth + 1);
    seen.delete(input);
  }
  visit(value, 0);
}

/** Bound allocation before reading, and keep the verified descriptor open. */
export async function readBoundedStoredFile(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("response_too_large");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== stat.size) throw new Error("response_corrupt");
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}
export async function verifyStoredResponse(input: { path: string; sha256: string }): Promise<boolean> {
  const bytes = await readBoundedStoredFile(input.path);
  return createHash("sha256").update(bytes).digest("hex") === input.sha256;
}

/** Inspect nested structure without materializing child values into a read page. */
export async function describeStoredValue(input: ReadWorkerInput): Promise<ResponseShape> {
  const bytes = await readBoundedStoredFile(input.path);
  if (createHash("sha256").update(bytes).digest("hex") !== input.expectedSha256) throw new Error("response_corrupt");
  const root: unknown = JSON.parse(bytes.toString("utf8"));
  checkShape(root, input.maxDepth, input.maxNodes);
  const selected = selectPointer(root, input.pointer);
  const keys = selected !== null && typeof selected === "object" ? Object.keys(selected) : [];
  if (!Array.isArray(selected)) keys.sort();
  const size = (value: unknown): number => Array.isArray(value) ? value.length : typeof value === "string" ? Array.from(value).length : value && typeof value === "object" ? Object.keys(value).length : 1;
  const children: ResponseShape["children"] = [];
  for (const key of keys.slice(input.offset, input.offset + input.limit)) {
    const value = (selected as Record<string, unknown>)[key];
    const child = { key, pointer: `${input.pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, type: shapeOf(value), size: size(value) };
    if (Buffer.byteLength(JSON.stringify([...children, child])) > input.maxBytes - 512) {
      if (!children.length) throw new Error("response_shape_element_too_large");
      break;
    }
    children.push(child);
  }
  const next = input.offset + children.length;
  return responseShapeSchema.parse({ type: shapeOf(selected), size: size(selected), offset: input.offset, totalChildren: keys.length, children, hasMore: next < keys.length, nextOffset: next < keys.length ? next : null });
}
