import {
  extendReveal,
  flushReveal,
  initialReveal,
  isRevealing,
  stepReveal,
  type RevealState,
} from "./stream-reveal";

/**
 * One reveal frame. 30fps is the rate at which prose stops reading as steps:
 * at a typical 60–120 characters per second a frame adds two to four
 * characters, about half a word. The fullscreen renderer's frame cap follows it.
 */
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

export interface StreamPacer<Kind> {
  /** Take in a delta of the stream `kind`. A change of kind shows everything of the previous one first. */
  receive(kind: Kind, delta: string): void;
  /** Show everything received so far, now. */
  flush(): void;
  /** Show everything, then forget the stream: the next delta starts a new one. */
  end(): void;
  /** Forget the stream without showing the rest, as when the transcript is cleared. */
  reset(): void;
  /** False shows every delta the moment it arrives. */
  setPaced(paced: boolean): void;
}

/**
 * Paces a streamed answer into whatever renders it, so text lands as a steady
 * flow instead of in the bursts the provider sends. It sits in front of the
 * store's scrollback, the one place both the fullscreen and the Ink renderer
 * read streamed text from, so the two pace identically, and a block the Ink
 * renderer commits to its static scrollback is never ahead of the text around
 * it.
 *
 * `apply` receives the text in order, already paced. The rate is
 * stream-reveal's: a backlog drains with a 250ms time constant, never slower
 * than 90 characters a second, never more than half a second behind, and it
 * stops only at word ends. The frame timer runs only while there is a backlog.
 */
export function createStreamPacer<Kind>(
  apply: (kind: Kind, delta: string) => void,
  timers: PacerTimers = REAL_TIMERS,
): StreamPacer<Kind> {
  let paced = false;
  let kind: Kind | undefined;
  let received = "";
  let applied = 0;
  let reveal: RevealState = initialReveal(timers.now());
  let stopTimer: (() => void) | undefined;

  const applyUpTo = (length: number): void => {
    if (kind === undefined || length <= applied) return;
    const delta = received.slice(applied, length);
    applied = length;
    apply(kind, delta);
  };

  const stop = (): void => {
    stopTimer?.();
    stopTimer = undefined;
  };

  const tick = (): void => {
    reveal = stepReveal(reveal, timers.now());
    applyUpTo(reveal.shown);
    if (!isRevealing(reveal)) stop();
  };

  const flush = (): void => {
    reveal = flushReveal(reveal, timers.now());
    applyUpTo(received.length);
    stop();
  };

  const forget = (): void => {
    stop();
    kind = undefined;
    received = "";
    applied = 0;
    reveal = initialReveal(timers.now());
  };

  return {
    receive(nextKind, delta) {
      if (delta.length === 0) return;
      if (kind !== undefined && nextKind !== kind) {
        flush();
        forget();
      }
      kind = nextKind;
      received += delta;
      if (!paced) {
        applyUpTo(received.length);
        reveal = flushReveal(extendReveal(reveal, received, timers.now()), timers.now());
        return;
      }
      reveal = extendReveal(reveal, received, timers.now());
      if (stopTimer === undefined && isRevealing(reveal)) {
        stopTimer = timers.every(REVEAL_FRAME_MS, tick);
      }
    },
    flush,
    end() {
      flush();
      forget();
    },
    reset: forget,
    setPaced(next) {
      paced = next;
      if (!paced) flush();
    },
  };
}
