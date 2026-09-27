/** Keywords whose value maps user-chosen names to subschemas, so their keys are never keywords. */
const NAMED_SUBSCHEMA_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

/**
 * Strip JSON Schema keywords that cost tokens on every request but tell the model nothing.
 *
 * - `$schema`: a dialect URI the provider never reads.
 * - `maximum: Number.MAX_SAFE_INTEGER` / `minimum: -Number.MAX_SAFE_INTEGER`: Zod emits these
 *   for every `.int()` as the safe-integer range, not a constraint anyone wrote.
 * - `propertyNames: { type: "string" }`: Zod emits it for every `z.record`, and JSON object
 *   keys are always strings.
 *
 * Every other keyword passes through, `additionalProperties: false` included: OpenAI's strict
 * function calling requires it on every object.
 */
export function compactToolJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(compactToolJsonSchema);
  }
  if (!isRecord(schema)) {
    return schema;
  }

  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (isNoiseKeyword(key, value)) {
      continue;
    }
    compacted[key] =
      NAMED_SUBSCHEMA_KEYWORDS.has(key) && isRecord(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, subschema]) => [
              name,
              compactToolJsonSchema(subschema),
            ]),
          )
        : compactToolJsonSchema(value);
  }
  return compacted;
}

function isNoiseKeyword(key: string, value: unknown): boolean {
  return (
    key === "$schema" ||
    (key === "maximum" && value === Number.MAX_SAFE_INTEGER) ||
    (key === "minimum" && value === -Number.MAX_SAFE_INTEGER) ||
    (key === "propertyNames" &&
      isRecord(value) &&
      Object.keys(value).length === 1 &&
      value["type"] === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
