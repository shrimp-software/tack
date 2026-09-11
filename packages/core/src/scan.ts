import { z } from "zod";
import { canonicalJson } from "./response-contracts.js";
const pointer = z
  .string()
  .max(512)
  .refine(
    (value) =>
      value === "" ||
      (value.startsWith("/") && /^(?:[^~]|~[01])*$/u.test(value)),
    "invalid JSON Pointer",
  );
const scalar = z.union([
  z.string().max(1024),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const scanSpecSchema = z
  .object({
    operation: z.enum(["rows", "count", "sum", "min", "max", "mean"]),
    value: pointer.optional(),
    numericStrings: z.boolean().optional(),
    groupBy: pointer.optional(),
    maxGroups: z.number().int().min(1).max(1000).optional(),
    where: z
      .array(
        z
          .object({
            pointer,
            op: z.enum(["eq", "ne", "lt", "lte", "gt", "gte"]),
            value: scalar,
          })
          .strict(),
      )
      .max(16)
      .optional(),
    select: z
      .array(z.object({ name: z.string().min(1).max(128), pointer }).strict())
      .max(32)
      .optional(),
  })
  .strict()
  .superRefine((spec, context) => {
    if (spec.groupBy !== undefined && spec.operation === "rows")
      context.addIssue({
        code: "custom",
        message: "grouping requires an aggregate",
      });
    if (spec.maxGroups !== undefined && spec.groupBy === undefined)
      context.addIssue({
        code: "custom",
        message: "maxGroups requires groupBy",
      });
    if (spec.operation !== "rows" && spec.select)
      context.addIssue({ code: "custom", message: "projection requires rows" });
    if (
      ["sum", "min", "max", "mean"].includes(spec.operation) &&
      spec.value === undefined
    )
      context.addIssue({
        code: "custom",
        message: "numeric aggregate requires a value pointer",
      });
    if (
      new Set(spec.select?.map((field) => field.name)).size !==
      (spec.select?.length ?? 0)
    )
      context.addIssue({
        code: "custom",
        message: "duplicate projection name",
      });
  });
export type ScanSpec = z.infer<typeof scanSpecSchema>;
export function validateScanSpec(value: unknown): ScanSpec {
  const text = canonicalJson(value);
  if (Buffer.byteLength(text) > 4096) throw new Error("scan_spec_too_large");
  return scanSpecSchema.parse(JSON.parse(text));
}
