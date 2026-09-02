import { describe, expect, it } from "vitest";

import type { JsonSchema } from "@tack/core";
import { compileSchema } from "../src/index.js";

describe("compileSchema", () => {
  it("namespaces root definitions so they cannot collide with the top-level name", async () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        node: { $ref: "#/definitions/Node" }
      },
      required: ["node"],
      additionalProperties: false,
      definitions: {
        Node: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false
        }
      }
    };

    const ts = await compileSchema(schema, "FooInput");

    expect(ts).toContain("export interface FooInput");
    // The `Node` definition is renamed under the top-level type, not left bare.
    expect(ts).toContain("FooInputNode");
    expect(ts).not.toMatch(/\binterface Node\b/);
  });

  it("preserves literal schema data that contains ref-looking keys", async () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        mode: { enum: [{ $ref: "#/keep/this/literal" }, "plain"] }
      },
      required: ["mode"],
      additionalProperties: false
    };

    const ts = await compileSchema(schema, "LiteralInput");

    // No throw for an unresolvable `$ref` because it was turned into a literal.
    expect(ts).toContain("export interface LiteralInput");
  });

  it("threads the context label into local-ref assertion errors", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { x: { $ref: "https://example.com/external.json" } }
    };

    expect(() => compileSchema(schema, "BadInput", { context: "described tool types" })).toThrow(
      /described tool types/
    );
  });
});
