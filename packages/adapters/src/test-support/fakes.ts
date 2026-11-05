/**
 * Typed stand-ins for tests. Each helper holds the one cast its pattern needs, so a test states
 * what it fakes instead of asserting through `unknown`.
 */

/**
 * Present a hand-written function as the global `fetch`. Sound for tests because the code under
 * test calls it only as a function and reads the response fields the handler returns; the handler
 * may return a partial response object, which is why it is not typed as `typeof fetch`.
 */
export function fakeFetch<Handler extends (...args: never[]) => unknown>(
  handler: Handler,
): typeof fetch {
  return handler as object as typeof fetch;
}

/**
 * Present an object that implements only the members a test exercises as the full `Target` (a
 * service, a tool registry, a partial response, a mocked function). Sound because the code under
 * test reads only the members the test supplies; reading any other member yields `undefined`.
 */
export function partialFake<Target>(implementation: object): Target {
  return implementation as Target;
}

/**
 * Present a value of the wrong shape as `Target`, for tests that feed deliberately invalid input
 * (a corrupted file, a malformed provider payload) to code that must tolerate it. Sound because
 * the test asserts how the code reacts to the invalid value, not that the value is valid.
 */
export function invalidInput<Target>(value: unknown): Target {
  return value as Target;
}
