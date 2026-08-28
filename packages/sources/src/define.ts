import { z } from "zod";

import type { JsonSchema } from "@tack/core";

/**
 * Non-enumerable runtime brand stamped on every {@link defineTool} result.
 * `Symbol.for` (not a plain `Symbol`) so discovery still recognises a definition
 * when the authoring module and the runtime resolve to different copies of this
 * package. It is a runtime detail only and deliberately not part of
 * {@link TackToolDefinition}.
 */
const TACK_TOOL = Symbol.for("tack.sources.tool");

/**
 * A schema for a tool's input or output. Either a Zod schema (validated on every
 * call and converted to JSON Schema for discovery) or a hand-written JSON Schema
 * object (used as-is, no runtime validation).
 */
export type ToolSchema = z.ZodType | JsonSchema;

interface BaseToolSpec {
  /** Stable identity for the tool. Discovery and invocation both key on it. */
  readonly name: string;
  readonly description?: string;
  readonly output?: ToolSchema;
}

export interface ZodToolSpec<TSchema extends z.ZodType, TOutput> extends BaseToolSpec {
  readonly input: TSchema;
  readonly handler: (input: z.output<TSchema>) => TOutput | Promise<TOutput>;
}

export interface PlainToolSpec<TInput, TOutput> extends BaseToolSpec {
  readonly input?: JsonSchema;
  readonly handler: (input: TInput) => TOutput | Promise<TOutput>;
}

export interface TackToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string | undefined;
  readonly inputSchema: JsonSchema | undefined;
  readonly outputSchema: JsonSchema | undefined;
  /** Validate and coerce raw args against the input schema; identity when there is no Zod schema. */
  readonly parse: (input: unknown) => unknown;
  readonly handler: (input: TInput) => Promise<TOutput>;
}

/**
 * Declare a tool backed by a local function. Collect these as named exports of a
 * module and point a Tack config entry at the file:
 *
 * ```jsonc
 * { "servers": { "local": { "transport": "module", "entry": "./tack/local.ts" } } }
 * ```
 */
export function defineTool<TSchema extends z.ZodType, TOutput>(
  spec: ZodToolSpec<TSchema, TOutput>
): TackToolDefinition<z.output<TSchema>, Awaited<TOutput>>;
export function defineTool<TInput, TOutput>(
  spec: PlainToolSpec<TInput, TOutput>
): TackToolDefinition<TInput, Awaited<TOutput>>;
/** Impl-signature union only — the two public forms are the overloads above. */
export function defineTool(
  spec: PlainToolSpec<unknown, unknown> | ZodToolSpec<z.ZodType, unknown>
): TackToolDefinition {
  const { input, handler } = spec;
  const parse = isZodSchema(input)
    ? (value: unknown): unknown => input.parse(value)
    : (value: unknown): unknown => value;

  const definition: TackToolDefinition = {
    name: spec.name,
    description: spec.description,
    inputSchema: toJsonSchema(input),
    outputSchema: toJsonSchema(spec.output),
    parse,
    handler: (value: unknown): Promise<unknown> => Promise.resolve(handler(value))
  };

  // Non-enumerable so the brand never leaks into discovery's export walk or a spread.
  return Object.defineProperty(definition, TACK_TOOL, { value: true });
}

export function isTackTool(value: unknown): value is TackToolDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[TACK_TOOL] === true
  );
}

function isZodSchema(value: ToolSchema | undefined): value is z.ZodType {
  return value instanceof z.ZodType;
}

function toJsonSchema(schema: ToolSchema | undefined): JsonSchema | undefined {
  if (!schema) {
    return undefined;
  }

  if (!isZodSchema(schema)) {
    return schema;
  }

  // `z.toJSONSchema` returns Zod's structural JSON Schema type; widen it to the
  // plain record the manifest carries.
  return z.toJSONSchema(schema) as unknown as JsonSchema;
}
