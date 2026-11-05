/**
 * Typed construction helpers for test doubles.
 */
import type { Effect } from "effect";

type AnyFunction = (...args: never[]) => unknown;
type AnyEffect = Effect.Effect<unknown, unknown, unknown>;

/**
 * The members a fake may supply for `T`: names are checked against the real type, while function
 * and Effect members accept any implementation so a fake can return a trimmed value.
 */
export type FakeMembers<T> = {
  [K in keyof T]?: T[K] extends AnyFunction
    ? AnyFunction
    : T[K] extends AnyEffect
      ? AnyEffect
      : T[K];
};

/**
 * Build a test double that implements only the members a test exercises.
 * Member names are checked against the real type; members left out are absent at runtime, so
 * code that reads one the test did not supply fails loudly instead of receiving a made-up value.
 * @param members - the members the test relies on.
 * @returns the partial object typed as the full service or value.
 */
export function partialFake<T extends object>(members: FakeMembers<T>): T {
  return members as T;
}

/**
 * Wrap a fetch implementation as a complete `typeof fetch`, adding the `preconnect` member the
 * runtime type requires.
 * @param implementation - the fetch behavior the test wants.
 * @returns a value assignable to `globalThis.fetch`.
 */
export function fakeFetch(implementation: (...args: never[]) => Promise<Response>): typeof fetch {
  const fetchLike = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> =>
    Reflect.apply(implementation, undefined, [input, init]) as Promise<Response>;
  return Object.assign(fetchLike, { preconnect: () => undefined });
}

/**
 * Supply a value of the wrong shape to prove the code under test rejects it. The sole sanctioned
 * route for invalid-input tests, so the deliberate type violation stays in one named place.
 * @param value - the malformed value.
 * @returns the value typed as the parameter it is being passed to.
 */
export function invalidInput<T>(value: unknown): T {
  return value as T;
}
