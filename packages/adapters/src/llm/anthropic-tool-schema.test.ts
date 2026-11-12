/** Regression coverage for legacy tuple migration and preservation of schema data. */
import { describe, expect, it } from "bun:test";
import { normalizeAnthropicToolSchema } from "./anthropic-tool-schema";

const integer = { type: "integer" };

describe("normalizeAnthropicToolSchema", () => {
  it("converts closed, open, and rest tuples while preserving bounds", () => {
    for (const rest of [undefined, false, { type: "string" }]) {
      const schema = {
        type: "array",
        items: [integer, integer],
        ...(rest === undefined ? {} : { additionalItems: rest }),
        minItems: 2,
        maxItems: 2,
      };
      expect(normalizeAnthropicToolSchema(schema)).toEqual({
        type: "array",
        prefixItems: [integer, integer],
        ...(rest === undefined ? {} : { items: rest }),
        minItems: 2,
        maxItems: 2,
      });
      expect(schema.items).toEqual([integer, integer]);
    }
  });

  it("traverses nested schema locations without interpreting names or literal data", () => {
    const tuple = { type: "array", items: [integer], additionalItems: false };
    const converted = { type: "array", prefixItems: [integer], items: false };
    const literal = { items: [1, 2], additionalItems: false };
    expect(
      normalizeAnthropicToolSchema({
        $defs: { items: tuple },
        properties: { items: { anyOf: [tuple, { type: "null" }] } },
        additionalProperties: { type: "array", items: tuple },
        default: literal,
        const: literal,
        enum: [literal],
        examples: [literal],
      }),
    ).toEqual({
      $defs: { items: converted },
      properties: { items: { anyOf: [converted, { type: "null" }] } },
      additionalProperties: { type: "array", items: converted },
      default: literal,
      const: literal,
      enum: [literal],
      examples: [literal],
    });
  });

  it("omits an empty prefixItems array, which the 2020-12 meta-schema rejects", () => {
    expect(
      normalizeAnthropicToolSchema({
        type: "array",
        items: [],
        additionalItems: false,
        maxItems: 0,
      }),
    ).toEqual({ type: "array", items: false, maxItems: 0 });
  });

  it("preserves modern tuples and ordinary arrays", () => {
    const schema = { prefixItems: [integer], items: false };
    expect(normalizeAnthropicToolSchema(schema)).toEqual(schema);
    expect(normalizeAnthropicToolSchema({ type: "array", items: integer })).toEqual({
      type: "array",
      items: integer,
    });
  });
});
