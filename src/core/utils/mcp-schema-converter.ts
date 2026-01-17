import { z } from "zod";
import type { MCPJSONSchema } from "../types/mcp";

/**
 * Convert MCP JSON Schema to Zod schema
 *
 * This module breaks down the schema conversion into smaller, testable functions.
 * Each function handles a specific schema type or pattern.
 */

/**
 * Convert a basic JSON Schema type to Zod
 */
function convertBasicType(type: string | undefined): z.ZodTypeAny {
  switch (type) {
    case "string":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    default:
      // Unknown type - default to empty object for LLM compatibility
      return z.object({});
  }
}

/**
 * Convert an enum schema to Zod
 */
function convertEnumSchema(enumValues: readonly unknown[]): z.ZodTypeAny {
  // Zod enum requires all values to be strings
  if (enumValues.every((v) => typeof v === "string")) {
    return z.enum(enumValues as [string, ...string[]]);
  }

  // For mixed types or non-string enums, use z.union with z.literal
  const validValues = enumValues.filter(
    (v): v is string | number | boolean | null =>
      v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  );

  if (validValues.length === 0) {
    return z.unknown();
  }

  if (validValues.length === 1) {
    return z.literal(validValues[0]);
  }

  // Create union of literals
  const unionParts = validValues.map((v) => z.literal(v));
  return z.union([
    unionParts[0],
    unionParts[1],
    ...unionParts.slice(2),
  ] as [z.ZodLiteral<string | number | boolean | null>, z.ZodLiteral<string | number | boolean | null>, ...z.ZodLiteral<string | number | boolean | null>[]]);
}

/**
 * Convert an object schema to Zod
 */
function convertObjectSchema(
  schema: MCPJSONSchema,
  convertSchema: (schema: unknown) => z.ZodTypeAny,
): z.ZodTypeAny {
  if (!schema.properties) {
    // Empty object or no properties
    return z.object({}).passthrough();
  }

  const zodShape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(schema.required || []);

  for (const [key, prop] of Object.entries(schema.properties)) {
    const propZodType = convertSchema(prop);
    const isRequired = required.has(key);
    zodShape[key] = isRequired ? propZodType : propZodType.optional();
  }

  const objectSchema = z.object(zodShape);

  // Handle additionalProperties
  if (schema.additionalProperties === false) {
    return objectSchema.strict();
  } else if (schema.additionalProperties === true || schema.additionalProperties !== undefined) {
    // Allow additional properties
    return objectSchema.passthrough();
  }

  return objectSchema;
}

/**
 * Convert an array schema to Zod
 */
function convertArraySchema(
  schema: MCPJSONSchema,
  convertSchema: (schema: unknown) => z.ZodTypeAny,
): z.ZodTypeAny {
  if (schema.items) {
    const itemSchema = convertSchema(schema.items);
    return z.array(itemSchema);
  }
  return z.array(z.unknown());
}

/**
 * Convert a union schema (oneOf/anyOf) to Zod
 */
function convertUnionSchema(
  options: readonly unknown[],
  convertSchema: (schema: unknown) => z.ZodTypeAny,
): z.ZodTypeAny {
  if (options.length === 0) {
    return z.unknown();
  }

  const zodOptions = options.map(convertSchema);
  const first = zodOptions[0];

  if (!first) {
    return z.unknown();
  }

  if (options.length === 1) {
    return first;
  }

  const second = zodOptions[1];
  if (!second) {
    return first;
  }

  if (options.length === 2) {
    return z.union([first, second]);
  }

  return z.union([
    first,
    second,
    ...zodOptions.slice(2),
  ] as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

/**
 * Convert an allOf schema to Zod (merges all schemas)
 */
function convertAllOfSchema(
  schemas: readonly unknown[],
  convertSchema: (schema: unknown) => z.ZodTypeAny,
): z.ZodTypeAny {
  const zodSchemas = schemas.map(convertSchema);
  return zodSchemas.reduce((acc, s) => acc.and(s), z.object({}));
}

/**
 * Check if a type includes "object"
 */
function isObjectType(type: string | readonly string[] | undefined): boolean {
  if (type === "object") {
    return true;
  }
  if (Array.isArray(type)) {
    return type.includes("object");
  }
  return false;
}

/**
 * Check if a type includes "array"
 */
function isArrayType(type: string | readonly string[] | undefined): boolean {
  if (type === "array") {
    return true;
  }
  if (Array.isArray(type)) {
    return type.includes("array");
  }
  return false;
}

/**
 * Main function to convert MCP JSON Schema to Zod schema
 *
 * @param mcpSchema - The MCP JSON Schema to convert
 * @param toolName - Optional tool name for error messages
 * @returns Zod schema
 */
export function convertMCPSchemaToZod(
  mcpSchema: unknown,
  toolName?: string,
): z.ZodTypeAny {
  // Validate input
  if (typeof mcpSchema !== "object" || mcpSchema === null) {
    // Invalid schema - default to empty object for LLM compatibility
    return z.object({});
  }

  const schema = mcpSchema as MCPJSONSchema;

  // Handle object type
  if (isObjectType(schema.type)) {
    return convertObjectSchema(schema, (s) => convertMCPSchemaToZod(s, toolName));
  }

  // Handle array type
  if (isArrayType(schema.type)) {
    return convertArraySchema(schema, (s) => convertMCPSchemaToZod(s, toolName));
  }

  // Handle enum
  if (schema.enum && schema.enum.length > 0) {
    return convertEnumSchema(schema.enum);
  }

  // Handle oneOf
  if (schema.oneOf && Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return convertUnionSchema(schema.oneOf, (s) => convertMCPSchemaToZod(s, toolName));
  }

  // Handle anyOf
  if (schema.anyOf && Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return convertUnionSchema(schema.anyOf, (s) => convertMCPSchemaToZod(s, toolName));
  }

  // Handle allOf
  if (schema.allOf && Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return convertAllOfSchema(schema.allOf, (s) => convertMCPSchemaToZod(s, toolName));
  }

  // Handle basic types
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  return convertBasicType(type);
}
