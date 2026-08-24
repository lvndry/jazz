import type { MCPElicitationField } from "@/core/types/mcp";

/**
 * Read the choices out of one schema node, whichever way it spells them.
 *
 * The spec grew four spellings: a bare `enum`, `enum` plus parallel
 * `enumNames`, and `oneOf`/`anyOf` arrays of `{ const, title }`. They all
 * mean "pick from this list", and a terminal should show a picker for each
 * rather than making someone type a raw value it could have offered.
 */
export function readChoices(
  node: Record<string, unknown> | undefined,
): readonly { value: string; label: string }[] | undefined {
  if (!node) return undefined;

  const enumValues = node["enum"];
  if (Array.isArray(enumValues)) {
    const enumNames = node["enumNames"];
    return enumValues.map((value, index) => ({
      value: String(value),
      label:
        Array.isArray(enumNames) && typeof enumNames[index] === "string"
          ? enumNames[index]
          : String(value),
    }));
  }

  const titled = node["oneOf"] ?? node["anyOf"];
  if (Array.isArray(titled)) {
    const options = titled
      .filter(
        (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
      )
      .filter((entry) => entry["const"] !== undefined)
      .map((entry) => ({
        value: String(entry["const"]),
        label: typeof entry["title"] === "string" ? entry["title"] : String(entry["const"]),
      }));
    if (options.length > 0) return options;
  }

  return undefined;
}

/**
 * Translate a server's requested schema into fields a terminal can render.
 *
 * The spec allows richer JSON Schema than a prompt can express, so anything
 * that does not map onto a line of text, a number, a yes/no, or a choice is
 * coerced to a string field and left to the user to type.
 */
export function toElicitationFields(requestedSchema: unknown): readonly MCPElicitationField[] {
  if (typeof requestedSchema !== "object" || requestedSchema === null) return [];

  const schema = requestedSchema as {
    properties?: Record<string, Record<string, unknown>>;
    required?: unknown;
  };
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );

  return Object.entries(schema.properties ?? {}).map((entry) => {
    const [name, property] = entry;
    const rawType = property["type"];
    const rawDefault = property["default"];

    const base = {
      name,
      required: required.has(name),
      ...(typeof property["title"] === "string" ? { title: property["title"] } : {}),
      ...(typeof property["description"] === "string"
        ? { description: property["description"] }
        : {}),
    };

    // A multi-select is an array whose *items* carry the choices.
    if (rawType === "array") {
      const items = property["items"];
      const options = readChoices(
        typeof items === "object" && items !== null
          ? (items as Record<string, unknown>)
          : undefined,
      );
      if (options) {
        return {
          ...base,
          type: "multi-enum" as const,
          options,
          ...(Array.isArray(rawDefault)
            ? { default: rawDefault.map((value) => String(value)) }
            : {}),
        };
      }
    }

    const options = readChoices(property);
    if (options) {
      return {
        ...base,
        type: "enum" as const,
        options,
        ...(typeof rawDefault === "string" ? { default: rawDefault } : {}),
      };
    }

    const type =
      rawType === "number" || rawType === "integer" || rawType === "boolean"
        ? rawType
        : ("string" as const);

    return {
      ...base,
      type,
      ...(typeof rawDefault === "string" ||
      typeof rawDefault === "number" ||
      typeof rawDefault === "boolean"
        ? { default: rawDefault }
        : {}),
    };
  });
}
