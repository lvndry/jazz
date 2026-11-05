import type { Effect } from "effect";

/**
 * What a fake may supply for `Value`: any subset of members, with Effects allowed to carry a partial
 * success value and any failure type. A union of shapes (a discriminated union) is faked as one
 * object whose keys come from every variant.
 */
type KeysOfUnion<Value> = Value extends unknown ? keyof Value : never;

type ValueOfKey<Value, Key extends PropertyKey> = Value extends unknown
  ? Key extends keyof Value
    ? Value[Key]
    : never
  : never;

type FakeMembers<Value> =
  | Value
  | (Value extends Effect.Effect<infer Success, infer _Failure, infer Requirements>
      ? Effect.Effect<FakeMembers<Success>, unknown, Requirements>
      : Value extends (...args: infer Args) => infer Result
        ? (...args: Args) => FakeMembers<Result>
        : never)
  | ([Value] extends [object]
      ? [Value] extends [Effect.Effect<unknown, unknown, unknown> | ((...args: never[]) => unknown)]
        ? never
        : { [Key in KeysOfUnion<Value>]?: FakeMembers<ValueOfKey<Value, Key>> }
      : never);

/**
 * Builds a test double that implements only the members a test exercises. The assertion is sound for
 * that use: every member given is checked against `Subject` at the call site (signatures, with
 * Effects free to fail with any error and succeed with a partial value), and the unit under test only
 * reaches the members the test supplies, so any other access is a test bug that fails loudly with a
 * TypeError instead of passing silently.
 */
export function partialFake<Subject extends object>(members: FakeMembers<Subject>): Subject {
  return members as Subject;
}
