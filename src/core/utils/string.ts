/**
 * Utility functions for string conversion and manipulation
 */

/**
 * Safely convert a value to a string, handling null/undefined/objects
 */
export function safeString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * Safely stringify unknown values for error messages and logging
 *
 * Handles all types including primitives, Error instances, objects, and circular references.
 * Provides meaningful string representations instead of '[object Object]'.
 *
 * @param value - The value to stringify
 * @returns A string representation of the value
 */
export function safeStringify(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return `[Error: ${value.constructor?.name || "Unknown"}]`;
  }
}

/**
 * Convert a string to PascalCase
 *
 * Handles camelCase, kebab-case, snake_case, and space-separated strings.
 * Examples:
 * - "notionMCP" -> "NotionMCP"
 * - "my-server" -> "MyServer"
 * - "my_server" -> "MyServer"
 * - "my server" -> "MyServer"
 *
 * @param str - The string to convert
 * @returns The string in PascalCase format
 */
export function toPascalCase(str: string): string {
  if (!str) return str;
  
  // Split by common separators (hyphens, underscores, spaces, or camelCase boundaries)
  const words = str
    .replace(/([a-z])([A-Z])/g, "$1 $2") // Add space before capital letters (camelCase)
    .split(/[\s\-_]+/) // Split on spaces, hyphens, or underscores
    .filter((word) => word.length > 0); // Remove empty strings
  
  // Capitalize first letter of each word and join
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}
