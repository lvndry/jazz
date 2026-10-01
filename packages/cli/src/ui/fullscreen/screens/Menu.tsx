/** @jsxImportSource @opentui/react */

/**
 * A titled list screen, such as settings: one row per choice, the current value beside it, and
 * the selection lifted onto the element plane with the accent bar. No keys are handled here.
 */

import type { ReactNode } from "react";
import { getGlyphs } from "../../glyphs";
import { clipTerminalCells, terminalCellWidth } from "../../text/terminal-cells";
import { groundPaint, THEME } from "../../theme";
import { measureFor, type Viewport } from "../types";

/** The bar cell plus one space; row text starts here. */
const GUTTER = 2;

/** Spaces between a label and its hint. */
const HINT_GAP = 3;

/** Header row, a blank under it, a blank above the keys row and the keys row itself. */
const CHROME_ROWS = 4;

export interface MenuChoice {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}

export interface MenuScreenProps {
  readonly title: string;
  readonly choices: readonly MenuChoice[];
  readonly selected: number;
  readonly viewport: Viewport;
}

interface MenuRow {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly selected: boolean;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** The rows that fit, windowed so the selection stays on screen. */
export function menuRows(
  choices: readonly MenuChoice[],
  selected: number,
  viewport: Viewport,
): MenuRow[] {
  const room = Math.max(1, viewport.height - CHROME_ROWS);
  const index = clamp(selected, 0, Math.max(0, choices.length - 1));
  const start =
    choices.length <= room ? 0 : clamp(index - Math.floor(room / 2), 0, choices.length - room);
  return choices.slice(start, start + room).map((choice, offset) => ({
    key: choice.value,
    label: choice.label,
    hint: choice.hint ?? "",
    selected: start + offset === index,
  }));
}

export function MenuScreen({ title, choices, selected, viewport }: MenuScreenProps): ReactNode {
  const glyphs = getGlyphs();
  const width = Math.min(viewport.width, measureFor(viewport.width).prose + GUTTER);
  const rows = menuRows(choices, selected, viewport);
  const labelWidth = Math.min(
    Math.floor((width - GUTTER) / 2),
    choices.reduce((most, choice) => Math.max(most, terminalCellWidth(choice.label)), 0),
  );
  const hintWidth = Math.max(0, width - GUTTER - labelWidth - HINT_GAP - 1);
  return (
    <box
      style={{
        width: viewport.width,
        height: viewport.height,
        flexDirection: "column",
        backgroundColor: groundPaint(),
      }}
    >
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <text style={{ wrapMode: "none", truncate: true }}>
          <b style={{ fg: THEME.selected }}>{" jazz"}</b>
          <span style={{ fg: THEME.muted }}>{`  ${title.toLowerCase()}`}</span>
        </text>
      </box>
      <box style={{ height: 1, flexShrink: 0 }} />
      {rows.map((row) => {
        const label = clipTerminalCells(row.label, labelWidth);
        const padding = " ".repeat(Math.max(0, labelWidth - terminalCellWidth(label)) + HINT_GAP);
        return (
          <box
            key={row.key}
            style={{
              width,
              height: 1,
              flexShrink: 0,
              backgroundColor: row.selected ? THEME.surfaceStrong : THEME.surface,
            }}
          >
            <text style={{ wrapMode: "none", truncate: true }}>
              <span style={{ fg: row.selected ? THEME.primary : THEME.muted }}>
                {row.selected ? glyphs.bandBar : " "}
              </span>
              <span style={{ fg: THEME.muted }}> </span>
              {row.selected ? (
                <b style={{ fg: THEME.selected }}>{label}</b>
              ) : (
                <span style={{ fg: THEME.secondary }}>{label}</span>
              )}
              <span style={{ fg: THEME.muted }}>{padding}</span>
              <span style={{ fg: THEME.muted }}>{clipTerminalCells(row.hint, hintWidth)}</span>
            </text>
          </box>
        );
      })}
      <box style={{ flexGrow: 1 }} />
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <box style={{ width: GUTTER, flexShrink: 0 }} />
        <text style={{ wrapMode: "none", truncate: true }}>
          <b style={{ fg: THEME.selected }}>enter</b>
          <span style={{ fg: THEME.secondary }}>{" choose"}</span>
          <span style={{ fg: THEME.muted }}>{"    "}</span>
          <b style={{ fg: THEME.selected }}>↑↓</b>
          <span style={{ fg: THEME.secondary }}>{" move"}</span>
          <span style={{ fg: THEME.muted }}>{"    "}</span>
          <b style={{ fg: THEME.muted }}>esc</b>
          <span style={{ fg: THEME.muted }}>{" back"}</span>
        </text>
      </box>
    </box>
  );
}
