/**
 * Owns only the reveal cursor, arrival lengths, and frame timer. Accepted text
 * stays in the caller's canonical source; every frame reads that source by
 * reference and publishes an absolute visible length. Reset invalidates even
 * a canceled callback that was already queued by the timer implementation.
 */
import {
  flushReveal,
  initialReveal,
  isRevealing,
  receiveTarget,
  stepReveal,
} from "./stream-reveal";

export const REVEAL_FRAME_MS = 33;
export interface PacerTimers {
  readonly now: () => number;
  readonly every: (intervalMs: number, tick: () => void) => () => void;
}
const REAL_TIMERS: PacerTimers = {
  now: () => Date.now(),
  every: (intervalMs, tick) => {
    const handle = setInterval(tick, intervalMs);
    return () => clearInterval(handle);
  },
};
export interface StreamSource {
  readonly id: string;
  readonly text: string;
}
export interface StreamPacer {
  /** Call after accepting text into source. Flush before changing its identity. */
  receive(): void;
  flush(): void;
  end(): void;
  reset(): void;
  setPaced(paced: boolean): void;
}

/** Reads source by reference; no full answer or separately concatenated text is retained. */
export function createStreamPacer(
  source: () => StreamSource | null,
  publish: (id: string, length: number) => void,
  timers: PacerTimers = REAL_TIMERS,
): StreamPacer {
  let paced = false;
  let id: string | undefined;
  let reveal = initialReveal(timers.now());
  let stopTimer: (() => void) | undefined;
  let epoch = 0;
  const stop = (): void => {
    stopTimer?.();
    stopTimer = undefined;
  };
  const forget = (): void => {
    stop();
    epoch += 1;
    id = undefined;
    reveal = initialReveal(timers.now());
  };
  const flush = (): void => {
    const current = source();
    if (current !== null && current.id === id) {
      reveal = flushReveal(receiveTarget(reveal, current.text.length, timers.now()), timers.now());
      publish(current.id, reveal.shown);
    }
    stop();
  };
  const tick = (): void => {
    const current = source();
    if (current === null || current.id !== id) {
      forget();
      return;
    }
    const before = reveal.shown;
    reveal = stepReveal(reveal, current.text, timers.now());
    if (reveal.shown !== before) publish(current.id, reveal.shown);
    if (!isRevealing(reveal)) stop();
  };
  return {
    receive() {
      const current = source();
      if (current === null) {
        forget();
        return;
      }
      if (id !== current.id) {
        forget();
        id = current.id;
      }
      reveal = receiveTarget(reveal, current.text.length, timers.now());
      if (!paced) {
        flush();
        return;
      }
      if (stopTimer === undefined && isRevealing(reveal)) {
        const scheduledEpoch = epoch;
        stopTimer = timers.every(REVEAL_FRAME_MS, () => {
          if (scheduledEpoch === epoch) tick();
        });
      }
    },
    flush,
    end() {
      flush();
      forget();
    },
    reset: forget,
    setPaced(next) {
      if (paced === next) return;
      paced = next;
      if (!paced) flush();
    },
  };
}
