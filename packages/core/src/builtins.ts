import { z } from "zod";

const failure = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});
const valueType = z.enum([
  "object",
  "array",
  "string",
  "number",
  "boolean",
  "null",
  "unknown",
]);
export const responseShapeSchema = z.object({
  type: valueType,
  size: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  totalChildren: z.number().int().nonnegative(),
  children: z.array(
    z.object({
      key: z.string(),
      pointer: z.string(),
      type: valueType,
      size: z.number().int().nonnegative(),
    }),
  ),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type ResponseShape = z.infer<typeof responseShapeSchema>;
const searchOutput = z.object({
  ok: z.literal(true),
  revision: z.string(),
  items: z.array(
    z.object({
      kind: z.enum(["tool", "namespace"]),
      path: z.string(),
      description: z.string().optional(),
      operations: z.number().optional(),
      params: z.array(z.string()).optional(),
      inputSchema: z.unknown().optional(),
      example: z.string().optional(),
      inputTypeScript: z.string().optional(),
      outputTypeScript: z.string().optional(),
      schemaTruncated: z.boolean().optional(),
      score: z.number().optional(),
    }),
  ),
  total: z.number(),
  hasMore: z.boolean(),
  nextOffset: z.number().nullable(),
});
const described = z.object({
  path: z.string(),
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  inputTypeScript: z.string().optional(),
  outputTypeScript: z.string().optional(),
  typeScriptDefinitions: z.string().optional(),
  examples: z.array(z.string()).optional(),
  schemaTruncated: z.boolean().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      suggestions: z.array(z.string()),
    })
    .optional(),
});

/** Canonical runtime contracts; ambient signatures are projected from these schemas. */
export const BUILTIN_CONTRACTS = {
  search: {
    input: z
      .object({
        query: z.string().max(512).optional(),
        namespace: z.string().max(256).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        offset: z.number().int().nonnegative().optional(),
        types: z.boolean().optional(),
        detail: z.enum(["summary", "callable", "full"]).optional(),
        revision: z.string().optional(),
      })
      .strict(),
    output: z.union([
      searchOutput,
      searchOutput.extend({ ok: z.literal(false), error: failure.shape.error }),
    ]),
  },
  "describe.tool": {
    input: z
      .object({
        path: z.string().min(1).max(512),
        types: z.boolean().optional(),
      })
      .strict(),
    output: z.union([described, failure]),
  },
  "guidance.read": {
    input: z.object({ name: z.enum(["execute"]).optional() }).strict(),
    output: z.union([z.string(), failure]),
  },
} as const;
export type BuiltinName = keyof typeof BUILTIN_CONTRACTS;
export const RESERVED_TOOL_KEYS: ReadonlySet<string> = new Set([
  "call",
  "then",
  ...Object.keys(BUILTIN_CONTRACTS).map((path) => path.split(".")[0]!),
]);

/** Only projects the JSON Schema vocabulary emitted by our builtin Zod schemas. */
export function builtinTypeScript(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  function render(s: Record<string, unknown>): string {
    if (s.anyOf)
      return (s.anyOf as Record<string, unknown>[]).map(render).join(" | ");
    if (s.oneOf)
      return (s.oneOf as Record<string, unknown>[]).map(render).join(" | ");
    if ("const" in s) return JSON.stringify(s.const);
    if (s.enum)
      return (s.enum as unknown[]).map((x) => JSON.stringify(x)).join(" | ");
    if (Array.isArray(s.type))
      return s.type.map((t) => render({ ...s, type: t })).join(" | ");
    if (s.type === "null") return "null";
    if (s.type === "integer" || s.type === "number") return "number";
    if (s.type === "string" || s.type === "boolean") return s.type;
    if (s.type === "array")
      return `Array<${render(s.items as Record<string, unknown>)}>`;
    if (s.type === "object") {
      const required = new Set(s.required as string[] | undefined);
      return `{ ${Object.entries(
        (s.properties ?? {}) as Record<string, Record<string, unknown>>,
      )
        .map(
          ([key, value]) =>
            `${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${render(value)};`,
        )
        .join(
          " ",
        )} ${s.additionalProperties === true ? "[key: string]: unknown;" : ""} }`;
    }
    return "unknown";
  }
  return render(json);
}
