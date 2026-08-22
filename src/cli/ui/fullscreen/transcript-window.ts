import { inputRows } from "./Input";
import { reservedHeight } from "./LiveZone";
import type { InputModel, LiveModel, Viewport } from "./types";

/** Header plus the rule under it. */
export const TRANSCRIPT_CHROME_ABOVE = 2;

/** Quiet gap above the composer, plus the footer. */
export const TRANSCRIPT_CHROME_BELOW = 2;

export function clampScrollFromBottom(
  scrollFromBottom: number,
  rowCount: number,
  visibleCount: number,
): number {
  const maxOffset = Math.max(0, rowCount - Math.max(0, visibleCount));
  return Math.max(0, Math.min(scrollFromBottom, maxOffset));
}

/**
 * Slice of rows that should be on screen.
 *
 * `scrollFromBottom` is 0 at the live edge (newest). Larger values walk toward
 * older rows. Short conversations return every row so the caller can pin them
 * above the composer.
 */
export function windowTranscriptRows<T>(
  rows: readonly T[],
  visibleCount: number,
  scrollFromBottom: number,
): readonly T[] {
  const count = Math.max(0, visibleCount);
  if (count === 0) return [];
  if (rows.length <= count) return rows;
  const offset = clampScrollFromBottom(scrollFromBottom, rows.length, count);
  const end = rows.length - offset;
  return rows.slice(end - count, end);
}

/**
 * Apply a scroll-transcript action.
 *
 * Negative `delta` walks toward older rows (PageUp, wheel up). Positive walks
 * toward the live edge (PageDown, wheel down). `end` jumps: negative is Home
 * (oldest), positive is End (newest).
 */
export function applyScrollDelta(
  scrollFromBottom: number,
  rowCount: number,
  visibleCount: number,
  delta: number,
  unit: "line" | "page" | "end",
): number {
  const count = Math.max(0, visibleCount);
  const maxOffset = Math.max(0, rowCount - count);
  if (unit === "end") return delta < 0 ? maxOffset : 0;
  const step = unit === "page" ? Math.max(1, count - 1) : 1;
  return clampScrollFromBottom(scrollFromBottom - delta * step, rowCount, count);
}

export function transcriptVisibleCount(args: {
  readonly viewport: Viewport;
  readonly live: LiveModel;
  readonly input: InputModel;
  readonly inputFocused: boolean;
}): number {
  const live = reservedHeight(args.live);
  const composer = inputRows(args.input, args.viewport, args.inputFocused).length;
  return Math.max(
    0,
    args.viewport.height - TRANSCRIPT_CHROME_ABOVE - TRANSCRIPT_CHROME_BELOW - live - composer,
  );
}

/** Wheel up is older; wheel down walks back to the live edge. */
export function wheelScrollDelta(direction: string, delta: number): number | null {
  if (direction !== "up" && direction !== "down") return null;
  const amount = Math.max(1, Math.trunc(delta));
  return direction === "up" ? -amount : amount;
}
