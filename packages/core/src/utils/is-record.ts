/** A non-null, non-array object, whose keys can be read as untrusted values. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
