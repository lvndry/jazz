import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { convertMCPSchemaToZod } from "./mcp-schema-converter";

describe("MCP Schema Converter", () => {
  describe("Basic Types", () => {
    it("should convert string type", () => {
      const schema = { type: "string" };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse("hello").success).toBe(true);
      expect(zodSchema.safeParse(123).success).toBe(false);
    });

    it("should convert number type", () => {
      const schema = { type: "number" };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse(42).success).toBe(true);
      expect(zodSchema.safeParse(3.14).success).toBe(true);
      expect(zodSchema.safeParse("42").success).toBe(false);
    });

    it("should convert integer type to number", () => {
      const schema = { type: "integer" };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse(42).success).toBe(true);
      expect(zodSchema.safeParse(3.14).success).toBe(true); // Zod doesn't distinguish int/float
    });

    it("should convert boolean type", () => {
      const schema = { type: "boolean" };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse(true).success).toBe(true);
      expect(zodSchema.safeParse(false).success).toBe(true);
      expect(zodSchema.safeParse("true").success).toBe(false);
    });

    it("should convert null type", () => {
      const schema = { type: "null" };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse(null).success).toBe(true);
      expect(zodSchema.safeParse(undefined).success).toBe(false);
    });

    it("should default to empty object for unknown type", () => {
      const schema = { type: "unknown_type" };
      const zodSchema = convertMCPSchemaToZod(schema);

      // Empty object schema accepts objects
      expect(zodSchema.safeParse({}).success).toBe(true);
    });
  });

  describe("Object Types", () => {
    it("should convert object schema with properties", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name"],
      };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse({ name: "John" }).success).toBe(true);
      expect(zodSchema.safeParse({ name: "John", age: 30 }).success).toBe(true);
      expect(zodSchema.safeParse({ age: 30 }).success).toBe(false); // name is required
    });

    it("should handle object without properties", () => {
      const schema = { type: "object" };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse({}).success).toBe(true);
      expect(zodSchema.safeParse({ any: "value" }).success).toBe(true);
    });

    it("should handle additionalProperties false (strict)", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        additionalProperties: false,
      };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse({ name: "John" }).success).toBe(true);
      expect(zodSchema.safeParse({ name: "John", extra: "value" }).success).toBe(false);
    });
  });

  describe("Array Types", () => {
    it("should convert array schema with items", () => {
      const schema = {
        type: "array",
        items: { type: "string" },
      };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse(["a", "b", "c"]).success).toBe(true);
      expect(zodSchema.safeParse([1, 2, 3]).success).toBe(false);
    });

    it("should handle array without items", () => {
      const schema = { type: "array" };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse([]).success).toBe(true);
      expect(zodSchema.safeParse([1, "mixed", true]).success).toBe(true);
    });
  });

  describe("Enum Types", () => {
    it("should convert string enum", () => {
      const schema = {
        enum: ["active", "inactive", "pending"],
      };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse("active").success).toBe(true);
      expect(zodSchema.safeParse("invalid").success).toBe(false);
    });

    it("should convert mixed type enum", () => {
      const schema = {
        enum: [1, "two", true],
      };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse(1).success).toBe(true);
      expect(zodSchema.safeParse("two").success).toBe(true);
      expect(zodSchema.safeParse(true).success).toBe(true);
      expect(zodSchema.safeParse("invalid").success).toBe(false);
    });
  });

  describe("Union Types", () => {
    it("should convert oneOf schema", () => {
      const schema = {
        oneOf: [
          { type: "string" },
          { type: "number" },
        ],
      };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse("hello").success).toBe(true);
      expect(zodSchema.safeParse(42).success).toBe(true);
      expect(zodSchema.safeParse(true).success).toBe(false);
    });

    it("should convert anyOf schema", () => {
      const schema = {
        anyOf: [
          { type: "string" },
          { type: "boolean" },
        ],
      };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse("hello").success).toBe(true);
      expect(zodSchema.safeParse(true).success).toBe(true);
    });

    it("should handle allOf schema (intersection)", () => {
      const schema = {
        allOf: [
          { type: "object", properties: { name: { type: "string" } } },
          { type: "object", properties: { age: { type: "number" } } },
        ],
      };
      const zodSchema = convertMCPSchemaToZod(schema);

      // allOf creates an intersection - should accept objects with both properties
      expect(zodSchema.safeParse({ name: "John", age: 30 }).success).toBe(true);
    });
  });

  describe("Const Values", () => {
    it("should convert string const", () => {
      const schema = { const: "specific_value" };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse("specific_value").success).toBe(true);
      expect(zodSchema.safeParse("other_value").success).toBe(false);
    });

    it("should convert number const", () => {
      const schema = { const: 42 };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse(42).success).toBe(true);
      expect(zodSchema.safeParse(43).success).toBe(false);
    });

    it("should convert boolean const", () => {
      const schema = { const: true };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse(true).success).toBe(true);
      expect(zodSchema.safeParse(false).success).toBe(false);
    });

    it("should convert null const", () => {
      const schema = { const: null };
      const zodSchema = convertMCPSchemaToZod(schema);

      expect(zodSchema.safeParse(null).success).toBe(true);
      expect(zodSchema.safeParse(undefined).success).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    it("should handle null input", () => {
      const zodSchema = convertMCPSchemaToZod(null);

      // Should default to empty object
      expect(zodSchema.safeParse({}).success).toBe(true);
    });

    it("should handle empty object schema", () => {
      const zodSchema = convertMCPSchemaToZod({});

      expect(zodSchema.safeParse({}).success).toBe(true);
    });

    it("should handle type as array (pick first)", () => {
      const schema = { type: ["string", "number"] };
      const zodSchema = convertMCPSchemaToZod(schema);

      // Should pick "string" as the first type
      expect(zodSchema.safeParse("hello").success).toBe(true);
    });

    it("should add description to schema", () => {
      const schema = {
        type: "string",
        description: "A user's email address",
        format: "email",
      };
      const zodSchema = convertMCPSchemaToZod(schema) as z.ZodString;

      // The description should be added to the schema
      expect(zodSchema.description).toContain("email address");
      expect(zodSchema.description).toContain("format: email");
    });

    it("should handle $ref with warning", () => {
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (msg: string) => warnings.push(msg);

      const schema = { $ref: "#/definitions/User" };
      const zodSchema = convertMCPSchemaToZod(schema, "test_tool");

      console.warn = originalWarn;

      // Should return unknown and log warning
      expect(zodSchema.safeParse("anything").success).toBe(true);
      expect(warnings.some(w => w.includes("$ref not supported"))).toBe(true);
    });

    it("should handle nested object schemas", () => {
      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              address: {
                type: "object",
                properties: {
                  city: { type: "string" },
                  zip: { type: "string" },
                },
              },
            },
          },
        },
      };
      const zodSchema = convertMCPSchemaToZod(schema);

      const validData = {
        user: {
          name: "John",
          address: {
            city: "NYC",
            zip: "10001",
          },
        },
      };

      expect(zodSchema.safeParse(validData).success).toBe(true);
    });
  });
});
