/** @jsxImportSource @opentui/react */

/**
 * A read-only command's answer, centered over the chat:
 *
 *    ┃ /info                                                       esc to close
 *    ┃
 *    ┃ info        title          Plan the offsite
 *    ┃             conversation   7f3c…
 *
 * Unlike the cards docked above the footer, nothing here waits on a person, so the
 * conversation keeps streaming around it and Esc puts it away.
 */

import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef, type ReactNode } from "react";
import { OVERLAY_Z_INDEX } from "./centered";
import { BAND_CHROME_COLUMNS, bandStyle, OVERLAY_MAX_WIDTH } from "./overlay-frame";
import { COMMAND_PANEL_HINT, commandPanelRows } from "../../command-panel";
import { getGlyphs, type GlyphSet } from "../../glyphs";
import { roleStyle } from "../../text/roles";
import { clipTerminalCells, terminalCellWidth } from "../../text/terminal-cells";
import { THEME } from "../../theme";
import { useThemeRevision } from "../theme-revision";
import type { CommandPanelOverlay, Viewport } from "../types";

/** The title row and the blank row under it. */
const TITLE_ROWS = 2;
/** The band's padding row above and below its content. */
const PADDING_ROWS = 2;
/** Rows and columns kept clear around the panel so the chat still shows behind it. */
const SCREEN_MARGIN = 2;
/** Narrowest the panel is drawn, so a one-line answer still reads as a panel. */
const MIN_INNER_WIDTH = 40;

/** The panel's size and placement, and its body wrapped to fit. */
export function commandPanelLayout(
  model: CommandPanelOverlay,
  viewport: Viewport,
  glyphs: GlyphSet,
) {
  const maxWidth = Math.max(
    BAND_CHROME_COLUMNS + 1,
    Math.min(OVERLAY_MAX_WIDTH, viewport.width - SCREEN_MARGIN * 2),
  );
  const maxInner = maxWidth - BAND_CHROME_COLUMNS;
  const rows = commandPanelRows(model.panel, glyphs, maxInner);
  const titleWidth = terminalCellWidth(`${model.panel.command}  ${COMMAND_PANEL_HINT}`);
  const widest = rows.reduce(
    (most, row) =>
      Math.max(
        most,
        row.reduce((total, segment) => total + terminalCellWidth(segment.text), 0),
      ),
    titleWidth,
  );
  const inner = Math.min(maxInner, Math.max(MIN_INNER_WIDTH, widest));
  const width = Math.min(viewport.width, inner + BAND_CHROME_COLUMNS);
  const maxHeight = Math.max(TITLE_ROWS + PADDING_ROWS + 1, viewport.height - SCREEN_MARGIN * 2);
  const height = Math.min(maxHeight, TITLE_ROWS + PADDING_ROWS + Math.max(1, rows.length));
  const bodyRows = Math.max(1, height - TITLE_ROWS - PADDING_ROWS);
  return {
    rows,
    width,
    inner,
    height,
    bodyRows,
    maxOffset: Math.max(0, rows.length - bodyRows),
    left: Math.max(0, Math.floor((viewport.width - width) / 2)),
    top: Math.max(0, Math.floor((viewport.height - height) / 2)),
  };
}

export interface CommandPanelProps {
  readonly model: CommandPanelOverlay;
  readonly viewport: Viewport;
}

export function CommandPanel({ model, viewport }: CommandPanelProps): ReactNode {
  useThemeRevision();
  const glyphs = getGlyphs();
  const { rows, width, inner, height, bodyRows, maxOffset, left, top } = commandPanelLayout(
    model,
    viewport,
    glyphs,
  );
  const offset = Math.max(0, Math.min(model.offset, maxOffset));

  const body = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    if (body.current !== null) body.current.scrollTop = offset;
  }, [offset]);

  const hint = maxOffset > 0 ? `up down to scroll  ${COMMAND_PANEL_HINT}` : COMMAND_PANEL_HINT;
  const titleRoom = Math.max(0, inner - terminalCellWidth(hint) - 2);

  return (
    <box
      style={{
        position: "absolute",
        zIndex: OVERLAY_Z_INDEX,
        left,
        top,
        width,
        height,
        flexDirection: "column",
        ...bandStyle(glyphs, THEME.surface, THEME.border),
        paddingTop: 1,
        paddingBottom: 1,
      }}
    >
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <text style={{ flexShrink: 0 }}>
          <b style={{ fg: THEME.selected }}>{clipTerminalCells(model.panel.command, titleRoom)}</b>
        </text>
        <box style={{ flexGrow: 1 }} />
        <text style={{ fg: THEME.muted, flexShrink: 0 }}>{hint}</text>
      </box>
      <box style={{ height: 1, flexShrink: 0 }} />

      <scrollbox
        style={{ height: bodyRows, flexShrink: 0 }}
        scrollbarOptions={{ visible: maxOffset > 0 }}
        ref={(instance: ScrollBoxRenderable | null) => {
          body.current = instance;
        }}
      >
        {rows.map((row, rowIndex) => (
          <box
            key={`${String(model.panel.id)}:${String(rowIndex)}`}
            style={{ height: 1, flexShrink: 0, flexDirection: "row" }}
          >
            <text style={{ flexShrink: 0 }}>
              {row.length === 0
                ? " "
                : row.map((segment, segmentIndex) => {
                    const style = roleStyle(segment.role);
                    return style.bold === true ? (
                      <b
                        key={String(segmentIndex)}
                        style={{ fg: style.fg }}
                      >
                        {segment.text}
                      </b>
                    ) : (
                      <span
                        key={String(segmentIndex)}
                        style={{ fg: style.fg }}
                      >
                        {segment.text}
                      </span>
                    );
                  })}
            </text>
          </box>
        ))}
      </scrollbox>
    </box>
  );
}
