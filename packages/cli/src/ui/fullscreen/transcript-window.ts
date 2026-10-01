/**
 * Vertical allocation and wheel-input normalization for the fullscreen shell.
 *
 * `allocateRegions` gives the transcript, live-work band, composer, and sub-agent list a
 * bounded share of the current viewport. ViewportController owns all transcript
 * position, follow intent and content anchoring.
 */
import { inputRows } from "./Input";
import { reservedHeight } from "./LiveZone";
import type { InputModel, LiveModel, Viewport } from "./types";

/** Header plus the blank row under it. */
export const TRANSCRIPT_CHROME_ABOVE = 2;

/** Quiet gap above the composer, plus the footer. */
export const TRANSCRIPT_CHROME_BELOW = 2;

export interface RegionHeights {
  readonly transcript: number;
  readonly live: number;
  readonly input: number;
  readonly subagents: number;
}

/**
 * Divide the rows between the regions that compete for them.
 *
 * Every region below the header is `flexShrink: 0`, so this arithmetic is the
 * only thing standing between a cramped terminal and a footer pushed off the
 * bottom of the screen. At the compact 32x10 floor, an open command list alone
 * wants more rows than exist, so the list is windowed around its selection.
 *
 * The order of service is the design: the composer is under the user's hands,
 * so it is served first, but never down to the last transcript row; the
 * sub-agent list comes next because it is the only way into a sub-agent; the live
 * band yields last because it is the only region whose content is transient.
 */
export function allocateRegions(args: {
  readonly viewport: Viewport;
  readonly live: LiveModel;
  readonly input: InputModel;
  readonly inputFocused: boolean;
  readonly subagentRows?: number;
  /**
   * Rows an open overlay card takes at the bottom of the screen. The transcript ends above it,
   * so the card never hides the lines it is about and every line stays reachable by scrolling.
   */
  readonly overlayRows?: number;
}): RegionHeights {
  const available = Math.max(
    0,
    args.viewport.height - TRANSCRIPT_CHROME_ABOVE - TRANSCRIPT_CHROME_BELOW,
  );
  if (available <= 0) return { transcript: 0, live: 0, input: 0, subagents: 0 };

  const inputBudget = Math.max(1, available - 1);
  const input = Math.min(
    inputRows(args.input, args.viewport, args.inputFocused, undefined, inputBudget).length,
    inputBudget,
  );
  const subagents = Math.min(
    Math.max(0, Math.trunc(args.subagentRows ?? 0)),
    Math.max(0, available - input - 1),
  );
  const live = reservedHeight(args.live, Math.max(0, available - input - subagents - 1));
  const aboveOverlay =
    args.overlayRows === undefined
      ? Number.POSITIVE_INFINITY
      : args.viewport.height - TRANSCRIPT_CHROME_ABOVE - args.overlayRows;
  const transcript = Math.max(0, Math.min(available - input - subagents - live, aboveOverlay));
  return { transcript, live, input, subagents };
}

export function transcriptVisibleCount(args: Parameters<typeof allocateRegions>[0]): number {
  return allocateRegions(args).transcript;
}

/** Wheel up is older; wheel down walks back to the live edge. */
export function wheelScrollDelta(direction: string, delta: number): number | null {
  if (direction !== "up" && direction !== "down") return null;
  const amount = Math.max(1, Math.trunc(delta));
  return direction === "up" ? -amount : amount;
}
