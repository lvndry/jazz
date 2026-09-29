/**
 * Poll `condition` until it holds, for tests that wait on a bridge's asynchronous work.
 *
 * The wait is bounded by wall-clock time rather than a count of short sleeps, whose real length
 * stretches under load (a coverage run, parallel suites), so a slow machine gets the same budget
 * as a fast one. Throws when `condition` still fails once `timeoutMs` has passed.
 */
export async function waitUntil(
  condition: () => boolean,
  timeoutMs: number = WAIT_UNTIL_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition never became true within ${String(timeoutMs)}ms`);
    }
    await Bun.sleep(WAIT_UNTIL_POLL_MS);
  }
}

/** Well past any bridge step on a loaded CI runner, and inside bun's 5s default test timeout. */
export const WAIT_UNTIL_TIMEOUT_MS = 3_000;

/** Short enough that a condition met early is seen within a few milliseconds. */
const WAIT_UNTIL_POLL_MS = 2;
