import { describe, expect, test } from "bun:test";
import { readChoices, toElicitationFields } from "./elicitation-schema";

function field(schema: Record<string, unknown>, required: string[] = []) {
  return toElicitationFields({ type: "object", properties: { probe: schema }, required })[0];
}

describe("readChoices", () => {
  test("reads a bare enum", () => {
    expect(readChoices({ enum: ["a", "b"] })).toEqual([
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ]);
  });

  test("pairs enumNames with enum values", () => {
    expect(readChoices({ enum: ["h1", "h2"], enumNames: ["Superman", "Batman"] })).toEqual([
      { value: "h1", label: "Superman" },
      { value: "h2", label: "Batman" },
    ]);
  });

  test("reads titled oneOf and anyOf const entries", () => {
    const expected = [{ value: "hero-1", label: "Superman" }];
    expect(readChoices({ oneOf: [{ const: "hero-1", title: "Superman" }] })).toEqual(expected);
    expect(readChoices({ anyOf: [{ const: "hero-1", title: "Superman" }] })).toEqual(expected);
  });

  test("falls back to the const when a titled entry has no title", () => {
    expect(readChoices({ oneOf: [{ const: "x" }] })).toEqual([{ value: "x", label: "x" }]);
  });

  test("returns undefined for a node with no choices", () => {
    expect(readChoices({ type: "string" })).toBeUndefined();
    expect(readChoices(undefined)).toBeUndefined();
    // A oneOf that is a real union rather than a choice list is not a picker.
    expect(readChoices({ oneOf: [{ type: "string" }, { type: "number" }] })).toBeUndefined();
  });
});

describe("toElicitationFields", () => {
  test("maps scalar types", () => {
    expect(field({ type: "string" })?.type).toBe("string");
    expect(field({ type: "boolean" })?.type).toBe("boolean");
    expect(field({ type: "integer" })?.type).toBe("integer");
    expect(field({ type: "number" })?.type).toBe("number");
  });

  test("coerces an unrenderable type to a string field", () => {
    expect(field({ type: "object" })?.type).toBe("string");
    expect(field({})?.type).toBe("string");
  });

  test("recognises all four ways the spec spells a single-select", () => {
    // Only the first two were handled originally; the titled forms silently
    // became free-text prompts asking for a raw value.
    expect(field({ type: "string", enum: ["a"] })?.type).toBe("enum");
    expect(field({ enum: ["a"], enumNames: ["A"] })?.type).toBe("enum");
    expect(field({ type: "string", oneOf: [{ const: "a", title: "A" }] })?.type).toBe("enum");
    expect(field({ type: "string", anyOf: [{ const: "a", title: "A" }] })?.type).toBe("enum");
  });

  test("recognises multi-select arrays in both spellings", () => {
    expect(field({ type: "array", items: { type: "string", enum: ["a"] } })?.type).toBe(
      "multi-enum",
    );
    expect(field({ type: "array", items: { anyOf: [{ const: "a", title: "A" }] } })?.type).toBe(
      "multi-enum",
    );
  });

  test("keeps an array without choices as a plain field", () => {
    expect(field({ type: "array", items: { type: "string" } })?.type).toBe("string");
  });

  test("carries titles, descriptions, and required flags", () => {
    const result = field({ type: "string", title: "Name", description: "Your name" }, ["probe"]);
    expect(result).toMatchObject({
      name: "probe",
      title: "Name",
      description: "Your name",
      required: true,
    });
  });

  test("marks unlisted fields optional", () => {
    expect(field({ type: "string" })?.required).toBe(false);
  });

  test("carries defaults of each shape", () => {
    expect(field({ type: "string", default: "x" })?.default).toBe("x");
    expect(field({ type: "integer", default: 42 })?.default).toBe(42);
    expect(field({ type: "boolean", default: true })?.default).toBe(true);
    expect(field({ type: "array", items: { enum: ["a", "b"] }, default: ["a"] })?.default).toEqual([
      "a",
    ]);
  });

  test("returns nothing for a schema with no properties", () => {
    expect(toElicitationFields({ type: "object" })).toEqual([]);
    expect(toElicitationFields(null)).toEqual([]);
    expect(toElicitationFields("nonsense")).toEqual([]);
  });
});
