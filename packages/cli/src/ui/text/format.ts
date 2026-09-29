/**
 * The numbers every renderer prints the same way: how long something took, how long something
 * has been running, and what a run cost. Fullscreen, Ink and plain output all call these, so a
 * duration or a price never reads one way in the footer and another in a receipt.
 */

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;

/** Below this a cost is shown to four decimals, so a cheap run never reads as free. */
const CENT_USD = 0.01;
/** Below this even four decimals would print zeros; the cost is shown as under it instead. */
const SMALLEST_SHOWN_USD = 0.0001;

function minutesAndSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  return `${String(minutes)}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * A finished duration to a tenth of a second: `0.8s`, `4.1s`, `2m 05s`. Used where the reader
 * compares one run with another (receipts, the turn summary, a reasoning line, a stop), so it
 * keeps one unit under a minute rather than switching to milliseconds.
 */
export function formatPreciseDuration(durationMs: number): string {
  const ms = Math.max(0, Math.round(durationMs));
  const tenths = Math.round(ms / 100) / 10;
  if (tenths < SECONDS_PER_MINUTE) {
    return `${tenths.toFixed(1)}s`;
  }
  return minutesAndSeconds(Math.round(ms / MS_PER_SECOND));
}

/**
 * A counter that is still running, in whole seconds rounded down: `0s`, `42s`, `3m 07s`. It
 * changes at most once a second however often the frame redraws, because digits changing faster
 * than they can be read are noise.
 */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / MS_PER_SECOND));
  if (totalSeconds < SECONDS_PER_MINUTE) {
    return `${String(totalSeconds)}s`;
  }
  return minutesAndSeconds(totalSeconds);
}

/** What a run cost: `$0.00`, `$0.0042`, `$1.27`, or `<$0.0001` when four decimals would round to zero. */
export function formatCost(costUsd: number): string {
  if (costUsd <= 0) {
    return "$0.00";
  }
  if (costUsd >= CENT_USD) {
    return `$${costUsd.toFixed(2)}`;
  }
  if (costUsd >= SMALLEST_SHOWN_USD) {
    return `$${costUsd.toFixed(4)}`;
  }
  return `<$${SMALLEST_SHOWN_USD.toFixed(4)}`;
}
