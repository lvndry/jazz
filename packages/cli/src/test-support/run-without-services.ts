import { Effect } from "effect";

/**
 * Runs an effect that the test expects to finish before it touches any service. A test that does
 * reach a service fails at runtime as a missing service rather than being satisfied silently.
 */
export function runWithoutServices<Value, Failure, Requirements>(
  effect: Effect.Effect<Value, Failure, Requirements>,
): Promise<Value> {
  return Effect.runPromise(effect as Effect.Effect<Value, Failure>);
}
