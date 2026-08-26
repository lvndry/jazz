/**
 * Utility functions for string conversion and manipulation
 */

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;
const REPLACEMENT_CHAR = "\uFFFD";

/**
 * Replace only **lone** Unicode surrogates so the string is safe for UTF-8
 * serialization (e.g. JSON, HTTP bodies, APIs that strict-validate).
 *
 * In UTF-16/JavaScript, any character above U+FFFF is stored as a surrogate
 * *pair* (high U+D800–U+DBFF + low U+DC00–U+DFFF). A lone surrogate (one
 * half without its pair) is invalid and causes errors on strict backends
 * (e.g. Python JSON, Nvidia API). This function replaces only those invalid
 * units; valid pairs and all other Unicode are left unchanged.
 *
 * Lone surrogates can appear from:
 * - **Slicing/substring** in the middle of a character (e.g. emoji, CJK
 *   supplement U+20000+, symbols above U+FFFF)
 * - **Wrong encoding** when decoding bytes (e.g. UTF-8 decoded as Latin-1,
 *   or concatenated buffers)
 * - **Corrupt data** from files, APIs, or copy-paste
 *
 * So it is not only an emoji issue—any character outside the BMP (above
 * U+FFFF) is represented as a pair in JS; if that pair is split or missing,
 * you get a lone surrogate. This sanitizer fixes all such cases.
 *
 * @param str - The string to sanitize
 * @returns A string safe for JSON/UTF-8 serialization
 */
export function sanitizeUnicodeSurrogates(str: string): string {
  if (typeof str !== "string" || str.length === 0) return str;
  return str.replace(/[\uD800-\uDFFF]/g, (ch: string, i: number, s: string) => {
    const code = ch.charCodeAt(0);
    const isHigh = code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;
    const isLow = code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX;
    if (isHigh) {
      const next = s.charCodeAt(i + 1);
      if (next >= LOW_SURROGATE_MIN && next <= LOW_SURROGATE_MAX) return ch;
      return REPLACEMENT_CHAR;
    }
    if (isLow) {
      const prev = s.charCodeAt(i - 1);
      if (prev >= HIGH_SURROGATE_MIN && prev <= HIGH_SURROGATE_MAX) return ch;
      return REPLACEMENT_CHAR;
    }
    return REPLACEMENT_CHAR;
  });
}

/** Sanitize string for LLM payloads (e.g. UTF-8–safe, no lone surrogates). */
export function sanitize(str: string): string {
  return sanitizeUnicodeSurrogates(str);
}

/**
 * Coerce a config/CLI value to a boolean.
 *
 * Accepts real booleans and the strings `jazz config set` stores (`"true"` /
 * `"false"`). Anything else falls back to `fallback`.
 */
export function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return fallback;
}

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
 * Build a sorted index containing the UTF-16 offset at which each line starts.
 *
 * Build this once and reuse it when many String or RegExp match offsets need
 * conversion to one-based line numbers.
 */
export function buildLineOffsets(content: string): number[] {
  const lineOffsets: number[] = [0];
  for (let index = 0; index < content.length; index++) {
    if (content[index] === "\n") lineOffsets.push(index + 1);
  }
  return lineOffsets;
}

/**
 * Find the one-based line containing a UTF-16 string offset using binary search.
 */
export function offsetToLine(lineOffsets: readonly number[], offset: number): number {
  let low = 0;
  let high = lineOffsets.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if ((lineOffsets[middle] as number) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low + 1;
}

/**
 * Return one-based line numbers for exact, non-empty substring occurrences.
 *
 * @param limit - Maximum matches to collect; defaults to all matches.
 */
export function findAllOccurrenceLineNumbers(
  content: string,
  search: string,
  limit = Number.POSITIVE_INFINITY,
): number[] {
  if (search.length === 0 || limit <= 0) return [];
  const lineOffsets = buildLineOffsets(content);
  const lineNumbers: number[] = [];
  let index = 0;
  while (lineNumbers.length < limit && (index = content.indexOf(search, index)) !== -1) {
    lineNumbers.push(offsetToLine(lineOffsets, index));
    index += search.length;
  }
  return lineNumbers;
}

/**
 * Convert camelCase, kebab-case, snake_case, or words to PascalCase.
 *
 * @param str - The string to convert.
 * @returns The PascalCase string.
 */
export function toPascalCase(str: string): string {
  if (!str) return str;

  // Split by common separators (hyphens, underscores, spaces, or camelCase boundaries)
  const words = str
    .replace(/([a-z])([A-Z])/g, "$1 $2") // Add space before capital letters (camelCase)
    .split(/[\s\-_]+/) // Split on spaces, hyphens, or underscores
    .filter((word) => word.length > 0); // Remove empty strings

  // Capitalize first letter of each word and join
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join("");
}
