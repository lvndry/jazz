import { Effect, Option } from "effect";

/**
 * Utility functions for safe JSON parsing
 */

/**
 * Safely parse JSON string, returning an Option.
 * Returns Option.some(parsed) on success, Option.none() on parse error.
 *
 */
export function safeParseJson<T>(text: string): Option.Option<T> {
  try {
    return Option.some(JSON.parse(text) as T);
  } catch {
    return Option.none();
  }
}

/**
 * Parse JSON string as an Effect, failing with a descriptive error on parse failure.
 * Useful for Effect-based workflows where parse errors should be propagated.
 *
 */
export function parseJson<T>(text: string): Effect.Effect<T, Error> {
  return Effect.try({
    try: () => JSON.parse(text) as T,
    catch: (error) => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Unknown parse error";
      return new Error(`Failed to parse JSON: ${message}`);
    },
  });
}
