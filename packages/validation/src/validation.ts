import { createHash } from "node:crypto";

import { Ajv as Ajv07, type ErrorObject, type Options, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonicalJson, sanitizeData, type JsonSchema, type ValidationStatus } from "@cbxss/tack-core";

export type ValidationDialect = "draft-07" | "2020-12";
export type ValidationMode = "strict" | "permissive";
export type ValidationPurpose = "input" | "output";
export type SchemaSupport = "supported" | "partial" | "unsupported" | "missing" | "unknown";

export interface ValidationCoverage {
  readonly assertions: "performed" | "not_performed";
  readonly schemaSupport: SchemaSupport;
  readonly localRefs: boolean;
  readonly remoteRefs: false;
  /** JSON Schema format is intentionally annotation-only in v1. */
  readonly formatAssertions: false;
}

export interface ValidationDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly pointer?: string;
  readonly schemaPath?: string;
  readonly keyword?: string;
}

export interface ValidationJob {
  readonly purpose: ValidationPurpose;
  readonly schema?: JsonSchema | boolean | undefined;
  readonly value: unknown;
  readonly mode?: ValidationMode | undefined;
  /** Source evidence is retained, never derived by this package. */
  readonly sourceRevision?: string | undefined;
  /** Effective contract evidence is retained, never replaced with a generated revision. */
  readonly effectiveRevision?: string | undefined;
}

export interface ValidationResult {
  readonly status: ValidationStatus;
  readonly validator: "ajv" | "none";
  readonly dialect?: ValidationDialect;
  readonly sourceRevision?: string;
  readonly effectiveRevision?: string;
  /** SHA-256 of the exact sanitized effective schema used for compilation. */
  readonly effectiveContractHash?: string;
  readonly coverage: ValidationCoverage;
  readonly diagnostics: readonly ValidationDiagnostic[];
}

export interface SchemaInspection {
  readonly support: SchemaSupport;
  readonly dialect?: ValidationDialect;
  readonly effectiveContractHash?: string;
  readonly hasFormat: boolean;
  readonly hasLocalRefs: boolean;
  readonly diagnostics: readonly ValidationDiagnostic[];
}

interface NormalizedSchema {
  readonly schema: JsonSchema | boolean;
  readonly dialect: ValidationDialect;
  readonly effectiveContractHash: string;
  readonly inspection: SchemaInspection;
}

interface CacheEntry {
  readonly validate?: ValidateFunction;
  readonly diagnostic?: ValidationDiagnostic;
}

const DRAFT_07_META = new Set([
  "http://json-schema.org/draft-07/schema#",
  "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft-07/schema"
]);
const DRAFT_2020_META = new Set([
  "https://json-schema.org/draft/2020-12/schema#",
  "https://json-schema.org/draft/2020-12/schema",
  "http://json-schema.org/draft/2020-12/schema#",
  "http://json-schema.org/draft/2020-12/schema"
]);
const FORMAT_ASSERTION_VOCABULARY = "https://json-schema.org/draft/2020-12/vocab/format-assertion";
const KNOWN_2020_VOCABULARIES = new Set([
  "https://json-schema.org/draft/2020-12/vocab/core",
  "https://json-schema.org/draft/2020-12/vocab/applicator",
  "https://json-schema.org/draft/2020-12/vocab/unevaluated",
  "https://json-schema.org/draft/2020-12/vocab/validation",
  "https://json-schema.org/draft/2020-12/vocab/format-annotation",
  "https://json-schema.org/draft/2020-12/vocab/content",
  "https://json-schema.org/draft/2020-12/vocab/meta-data"
]);

const BASE_COVERAGE = {
  assertions: "not_performed" as const,
  localRefs: false,
  remoteRefs: false as const,
  formatAssertions: false as const
};

function revisionFields(job: ValidationJob): Pick<ValidationResult, "sourceRevision" | "effectiveRevision"> {
  return {
    ...(job.sourceRevision !== undefined ? { sourceRevision: job.sourceRevision } : {}),
    ...(job.effectiveRevision !== undefined ? { effectiveRevision: job.effectiveRevision } : {})
  };
}

function result(
  job: ValidationJob,
  fields: Omit<ValidationResult, "sourceRevision" | "effectiveRevision"> &
    Partial<Pick<ValidationResult, "sourceRevision" | "effectiveRevision">>
): ValidationResult {
  return Object.freeze({ ...fields, ...revisionFields(job) });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && byteLength(value.slice(0, end)) > maxBytes) end -= 1;
  return value.slice(0, end);
}

/**
 * Diagnostics deliberately omit Ajv params: params can contain arbitrary
 * instance values. Field names, pointers, and generic assertion messages are
 * useful recovery hints without echoing input or output data.
 */
function diagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly pointer?: string;
  readonly schemaPath?: string;
  readonly keyword?: string;
}): ValidationDiagnostic {
  const candidate = {
    code: truncateUtf8(input.code, 160),
    message: truncateUtf8(input.message, 640),
    ...(input.pointer !== undefined ? { pointer: truncateUtf8(input.pointer, 640) } : {}),
    ...(input.schemaPath !== undefined ? { schemaPath: truncateUtf8(input.schemaPath, 640) } : {}),
    ...(input.keyword !== undefined ? { keyword: truncateUtf8(input.keyword, 160) } : {})
  } as ValidationDiagnostic;

  if (byteLength(JSON.stringify(candidate)) <= 2 * 1024) return Object.freeze(candidate);
  const withoutSchemaPath = { ...candidate };
  delete withoutSchemaPath.schemaPath;
  if (byteLength(JSON.stringify(withoutSchemaPath)) <= 2 * 1024) return Object.freeze(withoutSchemaPath);
  const withoutPointer = { ...withoutSchemaPath };
  delete withoutPointer.pointer;
  if (byteLength(JSON.stringify(withoutPointer)) <= 2 * 1024) return Object.freeze(withoutPointer);
  return Object.freeze({
    code: candidate.code,
    message: truncateUtf8(candidate.message, 1_600)
  });
}

function asSchemaRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function schemaMeta(schema: JsonSchema | boolean): unknown {
  return typeof schema === "boolean" ? undefined : schema["$schema"];
}

function dialectFor(schema: JsonSchema | boolean):
  | { readonly dialect: ValidationDialect }
  | { readonly diagnostic: ValidationDiagnostic } {
  const meta = schemaMeta(schema);
  if (meta === undefined) return { dialect: "2020-12" };
  if (typeof meta !== "string") {
    return { diagnostic: diagnostic({ code: "unsupported_dialect", message: "The declared JSON Schema dialect is unavailable" }) };
  }
  if (DRAFT_07_META.has(meta)) return { dialect: "draft-07" };
  if (DRAFT_2020_META.has(meta)) return { dialect: "2020-12" };
  return { diagnostic: diagnostic({ code: "unsupported_dialect", message: "The declared JSON Schema dialect is unavailable" }) };
}

function localRef(ref: string): boolean {
  return ref.startsWith("#");
}

function inspectSchemaFeatures(schema: JsonSchema | boolean): {
  readonly hasFormat: boolean;
  readonly hasLocalRefs: boolean;
  readonly diagnostic?: ValidationDiagnostic;
} {
  const seen = new WeakSet<object>();
  let hasFormat = false;
  let hasLocalRefs = false;
  let featureDiagnostic: ValidationDiagnostic | undefined;

  const visit = (value: unknown): void => {
    if (featureDiagnostic) return;
    if (typeof value !== "object" || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);
    const record = asSchemaRecord(value);
    if (!record) {
      if (Array.isArray(value)) for (const item of value) visit(item);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(record, "format")) hasFormat = true;
    for (const key of ["$ref", "$dynamicRef"] as const) {
      const ref = record[key];
      if (ref === undefined) continue;
      if (typeof ref !== "string" || !localRef(ref)) {
        featureDiagnostic = diagnostic({
          code: "external_ref_unsupported",
          message: "External JSON Schema references are unavailable"
        });
        return;
      }
      hasLocalRefs = true;
    }

    if (record["$vocabulary"] !== undefined) {
      if (typeof record["$vocabulary"] !== "object" || record["$vocabulary"] === null || Array.isArray(record["$vocabulary"])) {
        featureDiagnostic = diagnostic({ code: "unsupported_assertion", message: "The declared JSON Schema vocabulary is unavailable" });
        return;
      }
      for (const [vocabulary, required] of Object.entries(record["$vocabulary"] as Record<string, unknown>)) {
        if (required === true && (vocabulary === FORMAT_ASSERTION_VOCABULARY || !KNOWN_2020_VOCABULARIES.has(vocabulary))) {
          featureDiagnostic = diagnostic({ code: "unsupported_assertion", message: "A required JSON Schema assertion vocabulary is unavailable" });
          return;
        }
      }
    }

    for (const valueChild of Object.values(record)) visit(valueChild);
  };

  visit(schema);
  return { hasFormat, hasLocalRefs, ...(featureDiagnostic ? { diagnostic: featureDiagnostic } : {}) };
}

function normalizeSchema(schema: JsonSchema | boolean):
  | { readonly schema: JsonSchema | boolean; readonly normalized: NormalizedSchema }
  | { readonly diagnostic: ValidationDiagnostic } {
  let clean: JsonSchema | boolean;
  try {
    clean = sanitizeData(schema, { onCycle: "Cyclic JSON Schema is unsupported" }) as JsonSchema | boolean;
  } catch {
    return { diagnostic: diagnostic({ code: "unsupported_assertion", message: "The JSON Schema value is not supported" }) };
  }
  const dialect = dialectFor(clean);
  if (!("dialect" in dialect)) return dialect;
  const features = inspectSchemaFeatures(clean);
  if (features.diagnostic) return { diagnostic: features.diagnostic };
  let effectiveContractHash: string;
  try {
    effectiveContractHash = sha256(canonicalJson(clean));
  } catch {
    return { diagnostic: diagnostic({ code: "unsupported_assertion", message: "The JSON Schema value is not canonical JSON" }) };
  }
  const inspection: SchemaInspection = Object.freeze({
    support: "supported",
    dialect: dialect.dialect,
    effectiveContractHash,
    hasFormat: features.hasFormat,
    hasLocalRefs: features.hasLocalRefs,
    diagnostics: Object.freeze([])
  });
  return { schema: clean, normalized: { schema: clean, dialect: dialect.dialect, effectiveContractHash, inspection } };
}

function unsupportedInspection(
  schema: JsonSchema | boolean,
  issue: ValidationDiagnostic
): SchemaInspection {
  let dialect: ValidationDialect | undefined;
  const selected = dialectFor(schema);
  if ("dialect" in selected) dialect = selected.dialect;
  let hash: string | undefined;
  try {
    hash = sha256(canonicalJson(schema));
  } catch {
    // No generated revision is exposed when the effective schema is not hashable.
  }
  const features = inspectSchemaFeatures(schema);
  return Object.freeze({
    support: "unsupported",
    ...(dialect ? { dialect } : {}),
    ...(hash ? { effectiveContractHash: hash } : {}),
    hasFormat: features.hasFormat,
    hasLocalRefs: features.hasLocalRefs,
    diagnostics: Object.freeze([issue])
  });
}

export function inspectSchema(schema: JsonSchema | boolean): SchemaInspection {
  const normalized = normalizeSchema(schema);
  if ("normalized" in normalized) return normalized.normalized.inspection;
  return unsupportedInspection(schema, normalized.diagnostic);
}

function schemaForAjv(schema: JsonSchema | boolean): JsonSchema | boolean {
  if (typeof schema === "boolean" || !Object.prototype.hasOwnProperty.call(schema, "$schema")) return schema;
  const copy = Object.create(null) as JsonSchema;
  for (const [key, value] of Object.entries(schema)) {
    if (key !== "$schema") copy[key] = value;
  }
  return copy;
}

function coverage(
  inspection: SchemaInspection,
  assertions: ValidationCoverage["assertions"]
): ValidationCoverage {
  return Object.freeze({
    assertions,
    schemaSupport: inspection.support,
    localRefs: inspection.hasLocalRefs,
    remoteRefs: false,
    formatAssertions: false
  });
}

function unavailableResult(job: ValidationJob, inspection: SchemaInspection, issue: ValidationDiagnostic): ValidationResult {
  return result(job, {
    status: job.mode === "permissive" ? "skipped" : "unavailable",
    validator: "ajv",
    ...(inspection.dialect ? { dialect: inspection.dialect } : {}),
    ...(inspection.effectiveContractHash ? { effectiveContractHash: inspection.effectiveContractHash } : {}),
    coverage: coverage(inspection, "not_performed"),
    diagnostics: Object.freeze([issue])
  });
}

function missingSchemaResult(job: ValidationJob): ValidationResult {
  if (job.purpose === "output") {
    return result(job, {
      status: "unavailable",
      validator: "none",
      coverage: Object.freeze({ ...BASE_COVERAGE, schemaSupport: "missing" }),
      diagnostics: Object.freeze([diagnostic({ code: "output_schema_missing", message: "No output schema was declared; output validation is unavailable" })])
    });
  }
  const objectInput = typeof job.value === "object" && job.value !== null && !Array.isArray(job.value);
  return result(job, {
    status: objectInput ? "partial" : "failed",
    validator: "none",
    coverage: Object.freeze({ ...BASE_COVERAGE, schemaSupport: "missing" }),
    diagnostics: Object.freeze([diagnostic({
      code: objectInput ? "input_schema_missing" : "input_object_required",
      message: objectInput
        ? "No input schema was declared; only the baseline JSON-object calling convention was checked"
        : "No input schema was declared; the baseline calling convention requires a JSON object"
    })])
  });
}

function ajvOptions(): Options {
  return {
    strict: true,
    strictSchema: true,
    allErrors: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    validateFormats: false
  };
}

export class ValidationKernel {
  private readonly draft07: Ajv07;
  private readonly draft2020: Ajv2020;
  private readonly caches = new Map<ValidationDialect, Map<string, CacheEntry>>([
    ["draft-07", new Map()],
    ["2020-12", new Map()]
  ]);
  private compileCalls = 0;

  constructor() {
    this.draft07 = new Ajv07(ajvOptions());
    this.draft2020 = new Ajv2020(ajvOptions());
  }

  /** Number of actual Ajv compile() calls performed by this kernel. */
  get compileCount(): number {
    return this.compileCalls;
  }

  cacheSize(dialect?: ValidationDialect): number {
    if (dialect) return this.caches.get(dialect)?.size ?? 0;
    return [...this.caches.values()].reduce((total, cache) => total + cache.size, 0);
  }

  inspect(schema: JsonSchema | boolean): SchemaInspection {
    return inspectSchema(schema);
  }

  validate(job: ValidationJob): ValidationResult {
    if (job.schema === undefined) return missingSchemaResult(job);
    const normalized = normalizeSchema(job.schema);
    if (!("normalized" in normalized)) {
      return unavailableResult(job, unsupportedInspection(job.schema, normalized.diagnostic), normalized.diagnostic);
    }
    const { normalized: selected } = normalized;
    const inspection = selected.inspection;
    const cache = this.caches.get(selected.dialect)!;
    let entry = cache.get(selected.effectiveContractHash);
    if (!entry) {
      const ajv = selected.dialect === "draft-07" ? this.draft07 : this.draft2020;
      try {
        this.compileCalls += 1;
        entry = { validate: ajv.compile(schemaForAjv(selected.schema)) };
      } catch {
        entry = { diagnostic: diagnostic({ code: "schema_compile_failed", message: "The JSON Schema could not be compiled by Ajv" }) };
      }
      cache.set(selected.effectiveContractHash, entry);
    }

    if (entry.diagnostic) return unavailableResult(job, inspection, entry.diagnostic);
    let valid = false;
    try {
      valid = Boolean(entry.validate?.(job.value));
    } catch {
      return unavailableResult(job, inspection, diagnostic({ code: "schema_runtime_failed", message: "The JSON Schema validator could not evaluate this value" }));
    }
    if (valid) {
      return result(job, {
        status: "passed",
        validator: "ajv",
        dialect: selected.dialect,
        effectiveContractHash: selected.effectiveContractHash,
        coverage: coverage({ ...inspection, support: "supported" }, "performed"),
        diagnostics: Object.freeze([])
      });
    }

    const errors = entry.validate?.errors ?? [];
    return result(job, {
      status: "failed",
      validator: "ajv",
      dialect: selected.dialect,
      effectiveContractHash: selected.effectiveContractHash,
      coverage: coverage({ ...inspection, support: "supported" }, "performed"),
      diagnostics: Object.freeze([ajvDiagnostic(errors[0])])
    });
  }
}

function ajvDiagnostic(error: ErrorObject | undefined): ValidationDiagnostic {
  if (!error) return diagnostic({ code: "validation_failed", message: "The value does not satisfy the JSON Schema" });
  return diagnostic({
    code: "validation_failed",
    message: error.message ? `Value ${error.message}` : "The value does not satisfy the JSON Schema",
    ...(error.instancePath ? { pointer: error.instancePath } : {}),
    ...(error.schemaPath ? { schemaPath: error.schemaPath } : {}),
    keyword: error.keyword
  });
}

export function createValidationJobHandler(kernel = new ValidationKernel()): (job: ValidationJob) => ValidationResult {
  return (job) => kernel.validate(job);
}
