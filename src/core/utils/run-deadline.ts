import { Duration, Effect } from "effect";

/**
 * A run's wall-clock timeout budget that can be pushed out while the run is
 * blocked waiting on a human (e.g. an execute_command approval relayed
 * through the Telegram bridge). Without this, time spent waiting for a person
 * to tap Accept/Reject counts against the same budget as the agent's own
 * work, so a run can be killed mid-approval — and the tap arrives to find the
 * process already gone.
 */
export interface RunDeadline {
  /**
   * Push the deadline out so it is at least `minMs` from now. Called each
   * time the run starts blocking on human input; a stale deadline from
   * before the wait began is never allowed to fire while still waiting.
   */
  readonly extend: (minMs: number) => void;
  /** Effect that fails once the deadline passes. Race this against the run. */
  readonly watch: Effect.Effect<never, Error>;
}

const POLL_INTERVAL_MS = 1000;

export function createRunDeadline(timeoutMs: number): RunDeadline {
  let deadline = Date.now() + timeoutMs;

  const extend = (minMs: number): void => {
    const candidate = Date.now() + minMs;
    if (candidate > deadline) deadline = candidate;
  };

  const watch: Effect.Effect<never, Error> = Effect.gen(function* () {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return yield* Effect.fail(new Error(`Run exceeded the ${timeoutMs}ms timeout.`));
      }
      // Poll in short increments rather than sleeping for the full remaining
      // duration up front, so an extend() call made mid-sleep is honored
      // promptly instead of only on the next (already-scheduled) wakeup.
      yield* Effect.sleep(Duration.millis(Math.min(remaining, POLL_INTERVAL_MS)));
    }
  });

  return { extend, watch };
}
