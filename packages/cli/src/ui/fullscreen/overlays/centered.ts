import { terminalCellWidth } from "../terminal-cells";

/**
 * Only one overlay is ever open at a time, but painting order otherwise falls
 * back to source position among siblings with equal zIndex. Pinning it this
 * high keeps the overlay on top regardless of where it sits in App.tsx's tree.
 */
export const OVERLAY_Z_INDEX = 1000;

/**
 * Horizontal centering for overlay option blocks, shared by every picker-style
 * overlay so the treatment cannot drift between them.
 *
 * Returns the left padding that centers a block of `contentWidth` cells inside
 * `availableWidth`. Content at least as wide as the space stays flush — padding
 * a full-width list would only push it off-frame.
 */
export function centeredOffset(contentWidth: number, availableWidth: number): number {
  if (contentWidth >= availableWidth) return 0;
  return Math.max(0, Math.floor((availableWidth - contentWidth) / 2));
}

export function displayWidth(text: string): number {
  return terminalCellWidth(text);
}
