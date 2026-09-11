import { createHash } from "node:crypto";

/** Versioned, JSON-safe vocabulary shared by the later host/store phases. */
export const CONTRACT_FORMAT_VERSION = 1 as const;
export const RESPONSE_FORMAT = "tack-response-v1" as const;

export type ContractFormatVersion = typeof CONTRACT_FORMAT_VERSION;
export type SourceUuid = string;
export type OperationId = string;
export type CallId = string;
export type ResponseId = string;
export type CatalogRevision = string;
export type ContractRevision = string;
export type UpstreamOutcome = "not_started" | "succeeded" | "failed" | "unknown";
export type ValidationStatus = "passed" | "failed" | "partial" | "unavailable" | "skipped";
export type ValidationValidator = "ajv" | "zod" | "none";

export interface ValidationReport {
  readonly status: ValidationStatus;
  readonly validator: ValidationValidator;
  readonly schemaRevision?: string;
  readonly code?: string;
  readonly pointer?: string;
  readonly message?: string;
}

export interface CallEvidence {
  readonly callId: string;
  readonly operationId?: string;
  readonly validation: {
    readonly input: ValidationReport;
    readonly output: ValidationReport;
  };
}

/** Host-owned authorization vocabulary; callers cannot supply an owner key. */
export type Principal =
  | { readonly kind: "local"; readonly workspaceId: string }
  | { readonly kind: "user"; readonly workspaceId: string; readonly userId: string };

/** Canonical owner key shared by validation, responses, receipts, and all hosts. */
export function principalOwnerKey(principal: Principal): string {
  if (!principal || typeof principal.workspaceId !== "string" || !principal.workspaceId) throw new ContractValidationError("principal_workspace_missing", "principal workspaceId is required");
  if (principal.kind !== "local" && (principal.kind !== "user" || typeof principal.userId !== "string" || !principal.userId)) throw new ContractValidationError("principal_invalid", "A trusted local or configured user principal is required");
  const identity = principal.kind === "local" ? ["local"] : ["user", principal.userId];
  return createHash("sha256").update(canonicalJson(["tack-owner", 1, principal.workspaceId, identity]), "utf8").digest("hex");
}

export type AuthorizationCapability =
  | { readonly kind: "invoke"; readonly operationId: string }
  | { readonly kind: "read-response"; readonly responseId: string }
  | { readonly kind: "inspect-receipt"; readonly executionId: string };

export type CodeModeFailureCode =
  | "unknown_operation"
  | "ambiguous_operation"
  | "operation_denied"
  | "source_unavailable"
  | "input_validation_failed"
  | "validation_unavailable"
  | "tool_error"
  | "downstream_error"
  | "tool_timeout"
  | "input_validation_unavailable"
  | "internal_error"
  | "cancelled"
  | "output_validation_failed"
  | "response_storage_disabled"
  | "response_too_large"
  | "response_quota_exceeded"
  | "response_unserializable"
  | "response_persistence_failed";

export interface ResponseDescriptor {
  readonly id: string;
  readonly format: typeof RESPONSE_FORMAT;
  readonly bytes: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly captureComplete: true;
  readonly upstreamCompleteness: "unknown" | "partial" | "complete";
  readonly rootShape: "object" | "array" | "string" | "number" | "boolean" | "null" | "unknown";
  readonly shapePreview?: unknown;
}

/** A bounded contract error, suitable for exposing as a local validation failure. */
export class ContractValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ContractValidationError";
    this.code = code;
  }
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractValidationError("invalid_string", `${field} must be a non-empty string`);
  }
}

function safeInteger(value: unknown, field: string, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new ContractValidationError("invalid_integer", `${field} must be a safe integer >= ${minimum}`);
  }
}

/**
 * Canonical JSON for identity tuples. Object keys are sorted by JavaScript
 * code-unit order and only finite JSON numbers are admitted.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();

  function encode(input: unknown): string {
    if (input === null) return "null";
    switch (typeof input) {
      case "string": {
        const encoded = JSON.stringify(input);
        if (encoded === undefined) throw new ContractValidationError("non_json_value", "Canonical JSON could not encode a string");
        return encoded;
      }
      case "boolean":
        return input ? "true" : "false";
      case "number": {
        if (!Number.isFinite(input)) {
          throw new ContractValidationError("non_finite_number", "Canonical JSON only accepts finite numbers");
        }
        const encoded = JSON.stringify(input);
        if (encoded === undefined) throw new ContractValidationError("non_json_value", "Canonical JSON could not encode a number");
        return encoded;
      }
      case "object": {
        if (seen.has(input)) {
          throw new ContractValidationError("cyclic_value", "Canonical JSON does not accept cyclic values");
        }
        const prototype = Object.getPrototypeOf(input);
        if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) {
          throw new ContractValidationError("non_plain_object", "Canonical JSON only accepts plain objects");
        }
        seen.add(input);
        let encoded: string;
        if (Array.isArray(input)) {
          const values: string[] = [];
          for (let index = 0; index < input.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
            if (!descriptor || !("value" in descriptor)) {
              throw new ContractValidationError("sparse_array", "Canonical JSON does not accept sparse arrays or accessors");
            }
            values.push(encode(descriptor.value));
          }
          encoded = `[${values.join(",")}]`;
        } else {
          const keys = Object.keys(input).sort();
          const properties: string[] = [];
          for (const key of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(input, key);
            if (!descriptor || !("value" in descriptor)) {
              throw new ContractValidationError("accessor_value", "Canonical JSON does not invoke accessors");
            }
            properties.push(`${JSON.stringify(key)}:${encode(descriptor.value)}`);
          }
          encoded = `{${properties.join(",")}}`;
        }
        seen.delete(input);
        return encoded;
      }
      default:
        throw new ContractValidationError("non_json_value", "Canonical JSON does not accept undefined, bigint, functions, or symbols");
    }
  }

  return encode(value);
}

function digestTuple(tuple: readonly unknown[], prefix: string): string {
  return `${prefix}${createHash("sha256").update(canonicalJson(tuple), "utf8").digest("hex")}`;
}

export function createToolId(
  sourceUuid: string,
  bundledKeyOrNull: string | null,
  exactUpstreamName: string
): string {
  nonEmptyString(sourceUuid, "sourceUuid");
  if (bundledKeyOrNull !== null) nonEmptyString(bundledKeyOrNull, "bundledKeyOrNull");
  nonEmptyString(exactUpstreamName, "exactUpstreamName");
  return digestTuple(["tack-tool", 1, sourceUuid, bundledKeyOrNull, exactUpstreamName], "tool_");
}

export function createOperationId(
  toolId: string,
  injectedArgs: Readonly<Record<string, string>> = {}
): string {
  nonEmptyString(toolId, "toolId");
  const pairs = Object.keys(injectedArgs)
    .sort()
    .map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(injectedArgs, key);
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
        throw new ContractValidationError("invalid_injected_argument", "Injected arguments must be own string data properties");
      }
      return [key, descriptor.value] as const;
    });
  return digestTuple(["tack-operation", 1, toolId, pairs], "op_");
}

/** Compatibility spellings used by catalog callers. */
export const deriveToolId = createToolId;
export const deriveOperationId = createOperationId;
export const toolIdentityId = createToolId;
export const operationIdentityId = createOperationId;
export const canonicalJsonString = canonicalJson;

function assertValidationReport(value: unknown, field: string): asserts value is ValidationReport {
  const input = record(value);
  if (!input) throw new ContractValidationError("invalid_validation_report", `${field} must be an object`);
  if (!["passed", "failed", "partial", "unavailable", "skipped"].includes(input.status as string)) {
    throw new ContractValidationError("invalid_validation_status", `${field}.status is invalid`);
  }
  if (!["ajv", "zod", "none"].includes(input.validator as string)) {
    throw new ContractValidationError("invalid_validator", `${field}.validator is invalid`);
  }
  for (const key of ["schemaRevision", "code", "pointer", "message"] as const) {
    if (hasOwn(input, key) && input[key] !== undefined && typeof input[key] !== "string") {
      throw new ContractValidationError("invalid_validation_detail", `${field}.${key} must be a string`);
    }
  }
}

function assertDescriptor(value: unknown): asserts value is ResponseDescriptor {
  const input = record(value);
  if (!input) throw new ContractValidationError("invalid_response_descriptor", "response must be an object");
  const ownData = (field: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    if (!descriptor || !("value" in descriptor)) throw new ContractValidationError("accessor_value", `response.${field} must be an own data property`);
    return descriptor.value;
  };
  const id = ownData("id");
  const format = ownData("format");
  const bytes = ownData("bytes");
  const sha256 = ownData("sha256");
  const createdAt = ownData("createdAt");
  const expiresAt = ownData("expiresAt");
  const captureComplete = ownData("captureComplete");
  const upstreamCompleteness = ownData("upstreamCompleteness");
  const rootShape = ownData("rootShape");
  nonEmptyString(id, "response.id");
  if (format !== RESPONSE_FORMAT) throw new ContractValidationError("unsupported_response_format", "response.format is unsupported");
  safeInteger(bytes, "response.bytes", 1);
  nonEmptyString(sha256, "response.sha256");
  nonEmptyString(createdAt, "response.createdAt");
  nonEmptyString(expiresAt, "response.expiresAt");
  if (captureComplete !== true) throw new ContractValidationError("incomplete_capture", "Committed responses must have captureComplete=true");
  if (!["unknown", "partial", "complete"].includes(upstreamCompleteness as string)) {
    throw new ContractValidationError("invalid_upstream_completeness", "response.upstreamCompleteness is invalid");
  }
  if (!["object", "array", "string", "number", "boolean", "null", "unknown"].includes(rootShape as string)) {
    throw new ContractValidationError("invalid_root_shape", "response.rootShape is invalid");
  }
}

export function validateResponseDescriptor(value: unknown): asserts value is ResponseDescriptor {
  assertDescriptor(value);
}

export const assertValidResponseDescriptor = validateResponseDescriptor;

export function isValidResponseDescriptor(value: unknown): value is ResponseDescriptor {
  try {
    validateResponseDescriptor(value);
    return true;
  } catch {
    return false;
  }
}

/** Validates the Tack 2.0 result without changing the legacy CodeModeResult. */
export type ReadPageKind = "array" | "object" | "string" | "scalar";
export interface ReadPage {
  readonly ok: true;
  readonly responseId: string;
  readonly sha256: string;
  readonly pointer: string;
  readonly kind: ReadPageKind;
  readonly value: unknown;
  readonly offset: number;
  readonly returned: number;
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
}

function pageLength(kind: ReadPageKind, value: unknown): number {
  if (kind === "array" || kind === "object") {
    if (!Array.isArray(value)) throw new ContractValidationError("invalid_page_value", `${kind} page value must be an array`);
    return value.length;
  }
  if (kind === "string") {
    if (typeof value !== "string") throw new ContractValidationError("invalid_page_value", "string page value must be a string");
    return Array.from(value).length;
  }
  if (value !== null && typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new ContractValidationError("invalid_scalar", "scalar pages only accept null, boolean, or finite number");
  }
  return 1;
}

function assertObjectEntries(value: unknown): asserts value is readonly [string, unknown][] {
  if (!Array.isArray(value)) throw new ContractValidationError("invalid_object_page", "object page value must be [key,value] entries");
  let previous: string | undefined;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
      throw new ContractValidationError("invalid_object_entry", "object page entries must be [string,value]");
    }
    if (previous !== undefined && previous >= entry[0]) {
      throw new ContractValidationError("unsorted_object_page", "object page keys must be sorted and unique by code-unit order");
    }
    previous = entry[0];
  }
}

/** Enforces D05's non-empty/terminal/continuation paging invariants. */
export function validateReadPage(value: unknown): asserts value is ReadPage {
  const input = record(value);
  if (!input || input.ok !== true) throw new ContractValidationError("invalid_read_page", "read page must have ok=true");
  nonEmptyString(input.responseId, "responseId");
  nonEmptyString(input.sha256, "sha256");
  if (typeof input.pointer !== "string") throw new ContractValidationError("invalid_pointer", "pointer must be a string");
  if (!["array", "object", "string", "scalar"].includes(input.kind as string)) throw new ContractValidationError("invalid_page_kind", "page kind is invalid");
  const offset = input.offset;
  const returned = input.returned;
  const total = input.total;
  safeInteger(offset, "offset");
  safeInteger(returned, "returned");
  safeInteger(total, "total");
  const hasMore = input.hasMore;
  if (typeof hasMore !== "boolean" || !hasOwn(input, "nextOffset")) {
    throw new ContractValidationError("invalid_page_continuation", "invalid hasMore/nextOffset");
  }
  const rawNextOffset = input.nextOffset;
  let nextOffset: number | null;
  if (rawNextOffset === null) {
    nextOffset = null;
  } else {
    safeInteger(rawNextOffset, "nextOffset");
    nextOffset = rawNextOffset;
  }

  if (input.kind === "object") assertObjectEntries(input.value);
  const count = pageLength(input.kind as ReadPageKind, input.value);
  if (input.kind === "scalar") {
    if (offset !== 0 || total !== 1 || returned !== 1 || hasMore || nextOffset !== null) {
      throw new ContractValidationError("invalid_scalar_page", "scalars have exactly one terminal page at offset 0");
    }
    return;
  }

  const remaining = Math.max(0, total - offset);
  if (offset >= total) {
    if (returned !== 0 || count !== 0 || hasMore || nextOffset !== null) {
      throw new ContractValidationError("invalid_empty_final_page", "overshoot pages must be empty and terminal");
    }
    return;
  }
  if (count === 0 || returned === 0) {
    throw new ContractValidationError("empty_nonterminal_page", "a page before total must contain at least one element");
  }
  if (returned !== count || returned > remaining) {
    throw new ContractValidationError("invalid_page_count", "returned must equal the page value length and be <= total-offset");
  }
  if (returned < remaining) {
    if (!hasMore || nextOffset !== offset + returned) {
      throw new ContractValidationError("invalid_continuation", "nonterminal pages require the exact next offset");
    }
  } else if (hasMore || nextOffset !== null) {
    throw new ContractValidationError("invalid_terminal_page", "a page reaching total must be terminal");
  }
}

export const assertValidReadPage = validateReadPage;

export function isValidReadPage(value: unknown): value is ReadPage {
  try {
    validateReadPage(value);
    return true;
  } catch {
    return false;
  }
}

export type ScanStopReason = "record_limit" | "output_limit" | "artifact_limit" | "group_limit" | "deadline";
export interface ScanCoverage {
  readonly scanned: number;
  readonly total: number;
  readonly matched: number;
  readonly skippedTypeCount: number;
  readonly complete: boolean;
  readonly stopReason: ScanStopReason | null;
  readonly nextOffset: number | null;
  /** Optional on the wire; when omitted, a request is interpreted as offset 0. */
  readonly offset?: number;
}

export interface ScanCoverageContext {
  readonly offset?: number;
  readonly sourceTotal?: number;
}

/** Validates range, continuation, and whole-array fullness relationships. */
export function validateScanCoverage(value: unknown, context: ScanCoverageContext = {}): asserts value is ScanCoverage {
  const input = record(value);
  if (!input) throw new ContractValidationError("invalid_scan_coverage", "coverage must be an object");
  const scanned = input.scanned;
  const total = input.total;
  const matched = input.matched;
  const skippedTypeCount = input.skippedTypeCount;
  safeInteger(scanned, "coverage.scanned");
  safeInteger(total, "coverage.total");
  safeInteger(matched, "coverage.matched");
  safeInteger(skippedTypeCount, "coverage.skippedTypeCount");
  if (total === 0 && scanned !== 0) throw new ContractValidationError("scan_overrun", "scanned cannot exceed total");
  if (scanned > total) throw new ContractValidationError("scan_overrun", "scanned cannot exceed total");
  if (matched > scanned || skippedTypeCount > scanned) throw new ContractValidationError("invalid_scan_counts", "matched/skipped counts cannot exceed scanned");
  if (typeof input.complete !== "boolean" || (input.stopReason !== null && !["record_limit", "output_limit", "artifact_limit", "group_limit", "deadline"].includes(input.stopReason as string))) {
    throw new ContractValidationError("invalid_scan_status", "complete or stopReason is invalid");
  }
  const rawNextOffset = input.nextOffset;
  let nextOffset: number | null;
  if (rawNextOffset === null) {
    nextOffset = null;
  } else {
    safeInteger(rawNextOffset, "nextOffset");
    nextOffset = rawNextOffset;
  }
  const offsetInput = hasOwn(input, "offset") ? input.offset : 0;
  safeInteger(offsetInput, "scan offset");
  const offsetValue = context.offset ?? offsetInput;
  safeInteger(offsetValue, "scan offset");
  if (context.sourceTotal !== undefined && total !== context.sourceTotal) throw new ContractValidationError("scan_total_mismatch", "coverage total does not match the selected array");
  if (offsetValue > total && scanned !== 0) throw new ContractValidationError("scan_overrun", "overshoot scans cannot scan rows");

  const remaining = Math.max(0, total - offsetValue);
  if (scanned > remaining) throw new ContractValidationError("scan_range_overrun", "scanned exceeds the requested range");
  const reachesRangeEnd = scanned === remaining;
  if (input.complete) {
    if (offsetValue !== 0 || !reachesRangeEnd || input.stopReason !== null || nextOffset !== null) {
      throw new ContractValidationError("invalid_scan_complete", "complete requires a zero-offset whole-array scan with no continuation or stop reason");
    }
  }
  if (reachesRangeEnd) {
    if (nextOffset !== null || input.stopReason !== null) throw new ContractValidationError("invalid_scan_terminal", "a fully scanned range must not continue or carry a stop reason");
    if (offsetValue === 0 && !input.complete) throw new ContractValidationError("missing_scan_complete", "a zero-offset whole-array scan must be complete");
  } else {
    if (nextOffset !== null) {
      if (nextOffset <= offsetValue || nextOffset >= total || nextOffset !== offsetValue + scanned) {
        throw new ContractValidationError("invalid_scan_continuation", "nextOffset must be the exact in-range continuation offset");
      }
    } else if (input.stopReason === null) {
      throw new ContractValidationError("unexplained_scan_partial", "a partial scan requires nextOffset or an explicit stopReason");
    }
  }
}

export const assertValidScanCoverage = validateScanCoverage;

export function isValidScanCoverage(value: unknown, context?: ScanCoverageContext): value is ScanCoverage {
  try {
    validateScanCoverage(value, context);
    return true;
  } catch {
    return false;
  }
}

export type ReceiptResponseLinkRelation = "primary" | "derived";
export type ResponseLinkRelation = ReceiptResponseLinkRelation;
export const RECEIPT_RESPONSE_LINK_RELATIONS = ["primary", "derived"] as const;
export interface ReceiptResponseLink {
  readonly responseId: string;
  readonly relation: ReceiptResponseLinkRelation;
}

export function validateReceiptResponseLink(value: unknown): asserts value is ReceiptResponseLink {
  const input = record(value);
  if (!input) throw new ContractValidationError("invalid_response_link", "response link must be an object");
  nonEmptyString(input.responseId, "responseId");
  if (!RECEIPT_RESPONSE_LINK_RELATIONS.includes(input.relation as ReceiptResponseLinkRelation)) {
    throw new ContractValidationError("invalid_response_link_relation", "response link relation is invalid");
  }
}

export const assertValidReceiptResponseLink = validateReceiptResponseLink;
export const validateReceiptLink = validateReceiptResponseLink;

export function isValidReceiptResponseLink(value: unknown): value is ReceiptResponseLink {
  try {
    validateReceiptResponseLink(value);
    return true;
  } catch {
    return false;
  }
}

export const CONTRACT_LIMITS = {
  autoInlineBytes: 128 * 1024,
  descriptorBytes: 4 * 1024,
  shapePreviewBytes: 2 * 1024,
  pageBytes: 64 * 1024,
  maxPageElements: 1_000,
  maxJsonDepth: 64,
  maxNodes: 1_000_000,
  maxStoredResponseBytes: 32 * 1024 * 1024,
  maxScanRecords: 100_000,
  maxPayloadBytesPerOwner: 1 * 1024 * 1024 * 1024,
  maxPayloadBytesPerRoot: 4 * 1024 * 1024 * 1024,
  maxResponsesPerOwner: 10_000,
  maxResponsesPerRoot: 40_000,
  maxReceiptEvents: 2_048,
  maxReceiptBytesPerExecution: 2 * 1024 * 1024,
  maxReceiptCountPerOwner: 10_000,
  maxReceiptBytesPerOwner: 64 * 1024 * 1024,
  maxReceiptBytesPerRoot: 256 * 1024 * 1024,
  maxResponseLifetimeDays: 30,
  maxReceiptLifetimeDays: 30
} as const;

export const D05_LIMITS = CONTRACT_LIMITS;
export const D08_LIMITS = CONTRACT_LIMITS;
