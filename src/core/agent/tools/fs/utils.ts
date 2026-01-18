/**
 * Filesystem tools shared utilities
 */

/**
 * Normalize filter pattern to support both substring and regex matching
 */
export function normalizeFilterPattern(pattern?: string): {
  type: "substring" | "regex";
  value?: string;
  regex?: RegExp;
} {
  if (!pattern || pattern.trim() === "") return { type: "substring" };
  const trimmed = pattern.trim();
  if (trimmed.startsWith("re:")) {
    const body = trimmed.slice(3);
    try {
      return { type: "regex", regex: new RegExp(body) };
    } catch {
      return { type: "substring", value: body };
    }
  }

  return { type: "substring", value: trimmed };
}

/**
 * Normalize stat size to handle bigint, number, or string
 */
export function normalizeStatSize(size: unknown): number | string | null {
  if (typeof size === "bigint") {
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    if (size <= maxSafe && size >= -maxSafe) {
      return Number(size);
    }

    return size.toString();
  }

  if (typeof size === "number") {
    return size;
  }

  if (typeof size === "string") {
    return size;
  }

  return null;
}
