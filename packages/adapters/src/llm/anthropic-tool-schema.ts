/**
 * Adapt provider-facing tool schemas to Anthropic's JSON Schema 2020-12 tuple syntax.
 * Call after SDK conversion and compaction; validation still uses the original tool schema.
 * Only schema-bearing keywords are traversed, so defaults, examples, and enum values remain data.
 */
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_KEYWORDS = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);

/** Translate legacy tuples recursively without mutating the source or changing array bounds. */
export function normalizeAnthropicToolSchema(schema: unknown): unknown {
  if (!isRecord(schema)) {
    return schema;
  }
  const legacyTuple = Array.isArray(schema["items"]);
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (legacyTuple && key === "additionalItems") {
      continue;
    }
    if (legacyTuple && key === "items" && Array.isArray(value)) {
      if (value.length > 0) {
        normalized["prefixItems"] = value.map(normalizeAnthropicToolSchema);
      }
      if (schema["additionalItems"] !== undefined) {
        normalized["items"] = normalizeAnthropicToolSchema(schema["additionalItems"]);
      }
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
      normalized[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, normalizeAnthropicToolSchema(child)]),
      );
    } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      normalized[key] = value.map(normalizeAnthropicToolSchema);
    } else {
      normalized[key] = SCHEMA_KEYWORDS.has(key) ? normalizeAnthropicToolSchema(value) : value;
    }
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
