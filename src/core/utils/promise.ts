/**
 * Utility functions for promise manipulation
 */

/**
 * Creates a deferred promise with external resolve/reject controls.
 *
 */
export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Attach a no-op rejection handler so the promise is considered "handled".
  // Without this, rejecting a deferred that nobody consumes (e.g. the
  // streaming response deferred when the stream itself fails) causes an
  // unhandled-rejection that crashes the process.  Consumers that later
  // `.then()` / `.catch()` on the same `promise` reference still receive the
  // rejection normally — `.catch()` only forks a new chain, it does not
  // swallow the rejection for existing consumers.
  promise.catch(() => {});
  return { promise, resolve, reject };
}
