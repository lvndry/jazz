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
