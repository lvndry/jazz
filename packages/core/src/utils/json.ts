import { Effect, Option } from "effect";

/** JSON parsing adapters for optional and Effect-based control flow. */

/**
 * Safely parse JSON string, returning an Option.
 * Returns Option.some(parsed) on success, Option.none() on parse error.
 * The generic type is an unchecked cast; use boundary schema validation when
 * the parsed shape is untrusted.
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
 * The generic type is an unchecked cast and does not validate object shape.
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

/**
 * The JSON value in a model's answer: the whole answer, its last fenced block, or the last
 * object carrying `requiredKey` after the model's prose. Models routinely explain before they
 * emit the JSON they were asked for; what counts is the object, which the caller still has to
 * validate. Throws when the answer holds none.
 */
export function extractJsonObject(content: string, requiredKey: string): unknown {
  const trimmed = content.trim();
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].at(-1)?.[1];
  for (const candidate of [trimmed, fenced?.trim()]) {
    if (candidate === undefined) {
      continue;
    }
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Not the whole value; fall through to the next form.
    }
  }
  const end = trimmed.lastIndexOf("}");
  for (
    let start = trimmed.lastIndexOf("{", end);
    start >= 0;
    // lastIndexOf clamps a negative start to 0 and would find the same brace forever.
    start = start === 0 ? -1 : trimmed.lastIndexOf("{", start - 1)
  ) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      if (typeof parsed === "object" && parsed !== null && requiredKey in parsed) {
        return parsed;
      }
    } catch {
      // An inner brace; keep widening toward the start of the answer.
    }
  }
  throw new Error(`no JSON object with "${requiredKey}" in the answer`);
}
