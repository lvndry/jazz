/**
 * The members of `T` a test double chooses to provide. A method keeps its parameter types, so
 * callbacks are typed from the real service (parameters compare bivariantly, so a double may
 * narrow or widen what it accepts), and may return whatever the test needs; other
 * members are free-form values.
 */
export type PartialMembers<T> = {
  [Member in keyof T]?: T[Member] extends (...args: infer Args) => unknown
    ? Bivariant<Args>
    : unknown;
};

type Bivariant<Args extends readonly unknown[]> = {
  bivarianceHack(...args: Args): unknown;
}["bivarianceHack"];

/**
 * Builds a test double that implements only the members a test exercises and hands it to code
 * that expects the whole type. Member names and method parameters are checked against `T`, so a
 * misspelled or removed member fails typecheck; members left out are absent at runtime. This is
 * the one place a partial double is widened to its full type.
 */
export function partialFake<T extends object>(members: PartialMembers<T>): T {
  return members as T;
}
