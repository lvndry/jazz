import { describe, expect, it } from "bun:test";
import { compactToolJsonSchema } from "./tool-json-schema";

describe("compactToolJsonSchema", () => {
  it("drops $schema and Zod's default safe-integer bounds at every depth", () => {
    const compacted = compactToolJsonSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "integer",
            minimum: -Number.MAX_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        },
      },
    });

    expect(compacted).toEqual({
      type: "object",
      properties: { items: { type: "array", items: { type: "integer" } } },
    });
  });

  it("drops the propertyNames every z.record emits, but keeps a real key constraint", () => {
    expect(
      compactToolJsonSchema({
        type: "object",
        propertyNames: { type: "string" },
        additionalProperties: { type: "string" },
      }),
    ).toEqual({ type: "object", additionalProperties: { type: "string" } });
    expect(
      compactToolJsonSchema({ type: "object", propertyNames: { type: "string", pattern: "^x-" } }),
    ).toEqual({ type: "object", propertyNames: { type: "string", pattern: "^x-" } });
  });

  it("keeps bounds someone actually wrote", () => {
    expect(compactToolJsonSchema({ type: "integer", minimum: 0, maximum: 100 })).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 100,
    });
  });

  it("keeps additionalProperties: false, which OpenAI strict mode requires", () => {
    expect(compactToolJsonSchema({ type: "object", additionalProperties: false })).toEqual({
      type: "object",
      additionalProperties: false,
    });
  });

  it("treats keys under properties as names, never as keywords", () => {
    const schema = {
      type: "object",
      properties: { $schema: { type: "string" }, maximum: { type: "number" } },
    };

    expect(compactToolJsonSchema(schema)).toEqual(schema);
  });
});
