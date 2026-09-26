/** A caught value as an `Error`, wrapping anything that was thrown without being one. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
