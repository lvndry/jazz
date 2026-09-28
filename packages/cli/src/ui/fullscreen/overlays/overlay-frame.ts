/**
 * @fileoverview Where every overlay card sits, shared so the cards and the layout that makes
 * room for them agree.
 *
 * A card docks to the bottom of the screen and the conversation ends just above it, so nothing
 * the card is about (a plan, a command, the question's context) is hidden underneath it and
 * every line stays reachable by scrolling.
 */

import type { BorderCharacters } from "@opentui/core";
import type { GlyphSet } from "../../glyphs";
import type { Viewport } from "../types";

/** One cell between the bar and the text, and one before the right edge. */
export const BAND_PAD = 1;

/** Columns a band's bar and padding take from its width. */
export const BAND_CHROME_COLUMNS = 1 + BAND_PAD * 2;

/**
 * Cards and menus are bands, not boxes: a ground one step off the canvas with a
 * heavy bar down the left edge. Only the left side is drawn, so every other
 * character here is unused; they are the band bar too so a stray side can never
 * reach a box-drawing corner.
 */
export function bandBorderChars(glyphs: GlyphSet): BorderCharacters {
  return {
    topLeft: glyphs.bandBar,
    topRight: glyphs.bandBar,
    bottomLeft: glyphs.bandBar,
    bottomRight: glyphs.bandBar,
    horizontal: glyphs.bandBar,
    vertical: glyphs.bandBar,
    topT: glyphs.bandBar,
    bottomT: glyphs.bandBar,
    leftT: glyphs.bandBar,
    rightT: glyphs.bandBar,
    cross: glyphs.bandBar,
  };
}

/** Box style for a band whose bar is `bar` on the `surface` ground. */
export function bandStyle(glyphs: GlyphSet, surface: string, bar: string) {
  return {
    backgroundColor: surface,
    border: ["left"] as ("top" | "right" | "bottom" | "left")[],
    customBorderChars: bandBorderChars(glyphs),
    borderColor: bar,
    paddingLeft: BAND_PAD,
    paddingRight: BAND_PAD,
  };
}

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

/**
 * Where a card's frame starts. The frame and its one-cell padding put the card's
 * text on column 2, the same column the transcript's prose starts on, so the
 * card reads as part of the conversation's column rather than floating over it.
 */
export const OVERLAY_LEFT = 0;

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
  const left = frame.width >= viewport.width ? 0 : OVERLAY_LEFT;
  if (frame.fullscreen) {
    return { ...frame, height: viewport.height, left, top: 0 };
  }
  const room = Math.max(1, viewport.height - OVERLAY_FOOTER_ROWS);
  const height = Math.min(wantedHeight, room);
  return { ...frame, height, left, top: Math.max(0, room - height) };
}

/** A blank row between the conversation's last line and a docked card, so the band never touches text. */
export const OVERLAY_GAP_ROWS = 1;

/**
 * Rows a card keeps from the transcript: its own, the footer under a docked
 * card, and the gap above it.
 */
export function overlayReservedRows(
  placement: Pick<OverlayPlacement, "fullscreen" | "height">,
): number {
  return placement.fullscreen
    ? placement.height
    : placement.height + OVERLAY_FOOTER_ROWS + OVERLAY_GAP_ROWS;
}
