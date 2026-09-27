/**
 * @fileoverview Where every overlay card sits, shared so the cards and the layout that makes
 * room for them agree.
 *
 * A card docks to the bottom of the screen and the conversation ends just above it, so nothing
 * the card is about (a plan, a command, the question's context) is hidden underneath it and
 * every line stays reachable by scrolling.
 */

import type { Viewport } from "../types";

/** Widest a card is drawn; a narrower terminal gets a card as wide as itself. */
export const OVERLAY_MAX_WIDTH = 96;

/**
 * Fewest rows at which a docked card still leaves conversation worth reading above it; a
 * shorter terminal gives the card the whole screen.
 */
export const OVERLAY_MIN_WINDOWED_HEIGHT = 20;

/** The footer row a docked card sits above: it carries the hints for the card's keys. */
export const OVERLAY_FOOTER_ROWS = 1;

/** The side margin a card keeps when the terminal is wider than it. */
const SIDE_MARGIN = 4;

export interface OverlayWidth {
  readonly fullscreen: boolean;
  readonly width: number;
}

export interface OverlayPlacement extends OverlayWidth {
  readonly height: number;
  readonly left: number;
  readonly top: number;
}

/** How wide a card is, decided before its content is wrapped to that width. */
export function overlayWidth(viewport: Viewport): OverlayWidth {
  const fullscreen = viewport.height < OVERLAY_MIN_WINDOWED_HEIGHT;
  const width =
    fullscreen || viewport.width < OVERLAY_MAX_WIDTH
      ? viewport.width
      : Math.min(OVERLAY_MAX_WIDTH, viewport.width - SIDE_MARGIN);
  return { fullscreen, width };
}

/**
 * The card docked just above the footer, `wantedHeight` rows tall unless the screen is shorter.
 * A fullscreen card takes every row.
 */
export function placeOverlay(
  viewport: Viewport,
  frame: OverlayWidth,
  wantedHeight: number,
): OverlayPlacement {
  const left =
    frame.width >= viewport.width ? 0 : Math.max(0, Math.floor((viewport.width - frame.width) / 2));
  if (frame.fullscreen) {
    return { ...frame, height: viewport.height, left, top: 0 };
  }
  const room = Math.max(1, viewport.height - OVERLAY_FOOTER_ROWS);
  const height = Math.min(wantedHeight, room);
  return { ...frame, height, left, top: Math.max(0, room - height) };
}

/** Rows a card keeps from the transcript: its own, plus the footer under a docked card. */
export function overlayReservedRows(
  placement: Pick<OverlayPlacement, "fullscreen" | "height">,
): number {
  return placement.fullscreen ? placement.height : placement.height + OVERLAY_FOOTER_ROWS;
}
