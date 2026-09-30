/** @jsxImportSource @opentui/react */

/**
 * The theme picker: every theme and variant as a row with its own colours, and
 * the whole window previewing the highlighted one while you move.
 *
 *    ┃ Theme                                        previewing Catppuccin, dark
 *    ┃
 *    ┃ › Catppuccin      dark    █ █ █ █ █
 *    ┃   Catppuccin      light   █ █ █ █ █
 *    ┃   Jazz            dark    █ █ █ █ █                             current
 *
 * The swatches are the theme's accent, success, warning, error and keyword
 * colours, drawn in that theme's own values rather than the one on screen, so
 * the list can be compared without leaving it. The frame already shows the
 * highlighted theme; the swatches are there for the rows you have not reached.
 * The keys live in the footer, like every other card's.
 */

import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef, type ReactNode } from "react";
import { OVERLAY_Z_INDEX } from "./centered";
import { BAND_CHROME_COLUMNS, bandStyle, overlayWidth, placeOverlay } from "./overlay-frame";
import { getGlyphs } from "../../glyphs";
import { clipTerminalCells, terminalCellWidth } from "../../text/terminal-cells";
import { THEME } from "../../theme";
import { themePickerVisibleRows } from "../theme-picker-keys";
import { useThemeRevision } from "../theme-revision";
import type { ThemePickerModel, Viewport } from "../types";

/** The title row and the blank row under it. */
const TITLE_ROWS = 2;
/** The band's padding row above and below its content. */
const PADDING_ROWS = 2;

/** Enough rows for the built-ins plus a handful of your own before the list scrolls. */
const MAX_LIST_ROWS = 12;

const NAME_COLUMN = 16;
const VARIANT_COLUMN = 8;

/** The card's size and placement, shared with the layout that makes room for it. */
export function themePickerLayout(model: ThemePickerModel, viewport: Viewport) {
  const frame = overlayWidth(viewport);
  const visibleCount = themePickerVisibleRows(model.rows, model.selected).length;
  const wantedListRows = Math.max(1, Math.min(MAX_LIST_ROWS, visibleCount));
  const placement = placeOverlay(viewport, frame, TITLE_ROWS + PADDING_ROWS + wantedListRows);
  return {
    ...placement,
    inner: Math.max(8, frame.width - BAND_CHROME_COLUMNS),
    listRows: Math.max(1, placement.height - TITLE_ROWS - PADDING_ROWS),
  };
}

export interface ThemePickerProps {
  readonly model: ThemePickerModel;
  readonly viewport: Viewport;
}

export function ThemePicker({ model, viewport }: ThemePickerProps): ReactNode {
  useThemeRevision();
  const glyphs = getGlyphs();
  const { width, inner, height, listRows, left, top } = themePickerLayout(model, viewport);
  const selected = Math.max(0, Math.min(model.selected, model.rows.length - 1));
  const highlighted = model.rows[selected];
  const visibleRows = themePickerVisibleRows(model.rows, selected);
  const visibleSelected = Math.max(
    0,
    visibleRows.findIndex((row) => row.id === highlighted?.id),
  );

  const list = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    const box = list.current;
    if (box === null) return;
    if (visibleSelected < box.scrollTop) box.scrollTop = visibleSelected;
    else if (visibleSelected + 1 > box.scrollTop + listRows) {
      box.scrollTop = visibleSelected + 1 - listRows;
    }
  }, [visibleSelected, listRows]);

  const activeVariant = highlighted?.variant ?? "dark";
  const previewing = highlighted === undefined ? "" : `previewing ${highlighted.label}`;
  const titleRoom = Math.max(0, inner - terminalCellWidth("Theme  dark  light") - 2);

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
          <b style={{ fg: THEME.selected }}>Theme</b>
          {(["dark", "light"] as const).map((variant) =>
            variant === activeVariant ? (
              <b
                key={variant}
                style={{ fg: THEME.primary }}
              >{`  ${variant}`}</b>
            ) : (
              <span
                key={variant}
                style={{ fg: THEME.muted }}
              >{`  ${variant}`}</span>
            ),
          )}
        </text>
        <box style={{ flexGrow: 1 }} />
        <text style={{ fg: THEME.muted, flexShrink: 0 }}>
          {clipTerminalCells(previewing, titleRoom)}
        </text>
      </box>
      <box style={{ height: 1, flexShrink: 0 }} />

      <scrollbox
        style={{ height: listRows, flexShrink: 0 }}
        scrollbarOptions={{ visible: visibleRows.length > listRows }}
        ref={(instance: ScrollBoxRenderable | null) => {
          list.current = instance;
        }}
      >
        {visibleRows.map((row, index) => {
          const isSelected = index === visibleSelected;
          const name = clipTerminalCells(row.label, NAME_COLUMN - 1).padEnd(NAME_COLUMN);
          return (
            <box
              key={row.id}
              style={{
                height: 1,
                flexShrink: 0,
                flexDirection: "row",
                // The highlighted row lifts to the element plane, the same step
                // every other list uses, rather than changing colour alone.
                backgroundColor: isSelected ? THEME.surfaceStrong : THEME.surface,
              }}
            >
              <text style={{ fg: THEME.primary, flexShrink: 0 }}>
                {isSelected ? `${glyphs.arrow} ` : "  "}
              </text>
              <text style={{ flexShrink: 0 }}>
                {isSelected ? (
                  <b style={{ fg: THEME.selected }}>{name}</b>
                ) : (
                  <span style={{ fg: THEME.secondary }}>{name}</span>
                )}
              </text>
              <text style={{ fg: THEME.muted, flexShrink: 0 }}>
                {row.variant.padEnd(VARIANT_COLUMN)}
              </text>
              <text style={{ flexShrink: 0 }}>
                {row.swatches.map((swatch, swatchIndex) => (
                  <span
                    key={`${row.id}-${String(swatchIndex)}`}
                    style={{ fg: swatch }}
                  >
                    {`${glyphs.gridFilled} `}
                  </span>
                ))}
              </text>
              <box style={{ flexGrow: 1 }} />
              <text style={{ fg: THEME.muted, flexShrink: 0 }}>{row.current ? "current" : ""}</text>
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}
