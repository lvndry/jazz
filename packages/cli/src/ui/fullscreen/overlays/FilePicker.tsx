/** @jsxImportSource @opentui/react */

/**
 * The file picker overlay.
 *
 * Picking a file is a question about a tree, asked one filter at a time, so
 * three things have to be true at once: you can see where you are, you can
 * see what you typed, and the list does not move under you while you type.
 *
 *   - The frame keeps a fixed height. The entry count changes on every
 *     keystroke, and a card that grew and shrank with it would be unreadable
 *     — so the list region is reserved, not fitted.
 *   - Directories are told apart from files twice over: a marker in the
 *     gutter, and the path separator on the end of the name. Both survive a
 *     monochrome terminal, and neither is an emoji — the originals used
 *     folder and page pictographs, which live in ranges the target fonts do
 *     not cover and which render at the wrong advance width when they render
 *     at all.
 *   - Paths truncate from the left. The tail of a path is the file; the head
 *     is a prefix the reader already knows, so the ellipsis goes in front.
 *   - Selection is the rail and the name's weight, never a wash.
 */

import type { BorderCharacters } from "@opentui/core";
import type { ReactNode } from "react";
import { getGlyphs, type GlyphSet } from "../../glyphs";
import { THEME } from "../../theme";
import {
  clipTerminalCells,
  clipTerminalCellsFromStart,
  terminalCellWidth,
} from "../terminal-cells";
import type { Viewport } from "../types";
import { centeredOffset, OVERLAY_Z_INDEX } from "./centered";
import { HintRow, type Hint } from "./TextPrompt";

const MAX_WIDTH = 96;
const MIN_WINDOWED_HEIGHT = 20;

/** Fixed windowed height: the card does not resize as the filter narrows. */
const WINDOWED_HEIGHT = 19;

const CARD_PAD = 1;

/** Border, filter, base, rule, blank, count. */
const FIXED_CARD_ROWS = 8;

const HINT_ROWS = 1;

/** `» ` — the filter marker and the space after it. */
const MARKER_COLUMN = 2;

/** Rail, kind marker, space. */
const GUTTER = 3;

/** `base ` — the label in front of the root the entries are relative to. */
const BASE_LABEL = "base ";

const MESSAGE_MAX_ROWS = 2;

/** Keep this much context past the selection before the list starts to follow it. */
const LIST_MARGIN = 1;

export interface FileEntryModel {
  /** What to display — usually the path relative to `basePath`. */
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface FilePickerModel {
  readonly kind: "filepicker";
  readonly message: string;
  /** The root the entries are relative to, shown verbatim. */
  readonly basePath: string;
  readonly entries: readonly FileEntryModel[];
  readonly selected: number;
  /** What the user has typed to narrow the list. */
  readonly filter: string;
  /** Set while the tree is still being walked. */
  readonly scanning?: boolean;
  /** A failed selection, in prose. */
  readonly error?: string;
}

function displayWidth(text: string): number {
  return terminalCellWidth(text);
}

function clip(text: string, width: number): string {
  return clipTerminalCells(text, width);
}

/** Keep the tail: for a path, the last segment is the part being chosen. */
function clipLeft(text: string, width: number): string {
  return clipTerminalCellsFromStart(text, width);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function wrapProse(text: string, width: number, maxRows: number): string[] {
  const words = oneLine(text)
    .split(" ")
    .filter((word) => word.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (displayWidth(candidate) <= width) {
      line = candidate;
      continue;
    }
    if (line.length > 0) lines.push(line);
    line = displayWidth(word) <= width ? word : clip(word, width);
  }
  if (line.length > 0) lines.push(line);
  if (lines.length === 0) return [""];
  if (lines.length <= maxRows) return lines;
  const kept = lines.slice(0, maxRows);
  const last = kept[maxRows - 1] ?? "";
  kept[maxRows - 1] = clip(`${last} ${lines.slice(maxRows).join(" ")}`, width);
  return kept;
}

function frameChars(glyphs: GlyphSet): BorderCharacters {
  return {
    topLeft: glyphs.boxTL,
    topRight: glyphs.boxTR,
    bottomLeft: glyphs.boxBL,
    bottomRight: glyphs.boxBR,
    horizontal: glyphs.boxH,
    vertical: glyphs.boxV,
    topT: glyphs.boxTJ,
    bottomT: glyphs.boxBJ,
    leftT: glyphs.boxML,
    rightT: glyphs.boxMR,
    cross: glyphs.boxMJ,
  };
}

/** Derived, not remembered: see the same note on the question overlay. */
function windowStartFor(selected: number, total: number, rows: number): number {
  if (total <= rows) return 0;
  const wanted = selected + 1 + LIST_MARGIN - rows;
  return Math.max(0, Math.min(wanted, total - rows));
}

function countLabel(model: FilePickerModel): string {
  if (model.scanning === true) return "looking";
  const total = model.entries.length;
  if (total === 0) return "nothing here";
  if (total === 1) return "1 entry";
  return `${String(total)} entries`;
}

const HINTS: readonly Hint[] = [
  { key: "up/down", label: "move", expendable: 3 },
  { key: "tab", label: "complete", expendable: 4 },
  { key: "enter", label: "choose", expendable: 1 },
  { key: "esc", label: "cancel", expendable: 0 },
];

export interface FilePickerProps {
  readonly model: FilePickerModel;
  readonly viewport: Viewport;
}

export function FilePicker({ model, viewport }: FilePickerProps): ReactNode {
  const glyphs = getGlyphs();

  const fullscreen = viewport.width < MAX_WIDTH || viewport.height < MIN_WINDOWED_HEIGHT;
  const width = fullscreen ? viewport.width : Math.min(MAX_WIDTH, viewport.width - 4);
  const inner = Math.max(8, width - 2 - CARD_PAD * 2);

  const message = wrapProse(model.message, inner, MESSAGE_MAX_ROWS);
  const height = fullscreen
    ? viewport.height
    : Math.min(WINDOWED_HEIGHT + message.length, viewport.height);
  const cardHeight = Math.max(1, height - HINT_ROWS);
  const listRows = Math.max(1, cardHeight - FIXED_CARD_ROWS - message.length);

  const total = model.entries.length;
  const selected = total === 0 ? 0 : Math.max(0, Math.min(model.selected, total - 1));
  const start = windowStartFor(selected, total, listRows);
  const visible = model.entries.slice(start, start + listRows);

  const left = fullscreen ? 0 : Math.max(0, Math.floor((viewport.width - width) / 2));
  const top = fullscreen ? 0 : Math.max(0, Math.floor((viewport.height - height) / 2));

  const nameWidth = Math.max(4, inner - GUTTER);
  const error = oneLine(model.error ?? "");

  const widestEntry = visible.reduce(
    (widest, entry) => Math.max(widest, displayWidth(oneLine(entry.name))),
    0,
  );
  const listOffset = centeredOffset(GUTTER + widestEntry, inner);

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
      }}
    >
      <box
        style={{
          height: cardHeight,
          flexShrink: 0,
          flexDirection: "column",
          backgroundColor: THEME.surface,
          border: true,
          customBorderChars: frameChars(glyphs),
          borderColor: THEME.border,
          paddingLeft: CARD_PAD,
          paddingRight: CARD_PAD,
        }}
      >
        {message.map((line, index) => (
          <text
            key={`message-${String(index)}`}
            style={{ fg: THEME.selected, height: 1, flexShrink: 0 }}
          >
            {line}
          </text>
        ))}

        <box style={{ height: 1, flexShrink: 0 }} />

        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          <text style={{ fg: THEME.primary, width: MARKER_COLUMN, flexShrink: 0 }}>
            {`${glyphs.promptCursor} `}
          </text>
          <text style={{ fg: THEME.selected, flexShrink: 0 }}>
            {clipLeft(oneLine(model.filter), Math.max(4, inner - MARKER_COLUMN))}
          </text>
        </box>

        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          <text style={{ fg: THEME.muted, flexShrink: 0 }}>{BASE_LABEL}</text>
          <text style={{ fg: THEME.muted, flexShrink: 0 }}>
            {clipLeft(model.basePath, Math.max(4, inner - displayWidth(BASE_LABEL)))}
          </text>
        </box>

        <text style={{ fg: THEME.border, height: 1, flexShrink: 0 }}>
          {glyphs.divider.repeat(inner)}
        </text>

        <box
          style={{
            height: listRows,
            flexShrink: 0,
            flexDirection: "column",
            paddingLeft: listOffset,
          }}
        >
          {total === 0 ? (
            <text style={{ fg: THEME.secondary, height: 1, flexShrink: 0 }}>
              {clip(
                model.scanning === true
                  ? "Looking through the tree."
                  : `Nothing under this base matches "${oneLine(model.filter)}".`,
                inner,
              )}
            </text>
          ) : (
            visible.map((entry, offset) => {
              const index = start + offset;
              const isSelected = index === selected;
              // Two independent channels for the same fact, so neither colour
              // nor a single glyph is load-bearing on its own.
              const name = entry.isDirectory ? `${oneLine(entry.name)}/` : oneLine(entry.name);
              const shown = clipLeft(name, nameWidth);
              const nameColor = isSelected
                ? THEME.selected
                : entry.isDirectory
                  ? THEME.secondary
                  : THEME.muted;
              return (
                <box
                  key={`${entry.name}-${String(index)}`}
                  style={{ height: 1, flexShrink: 0, flexDirection: "row" }}
                >
                  <text style={{ fg: THEME.primary, width: 1, flexShrink: 0 }}>
                    {isSelected ? glyphs.rail : " "}
                  </text>
                  <text style={{ fg: THEME.muted, width: GUTTER - 1, flexShrink: 0 }}>
                    {entry.isDirectory ? `${glyphs.arrow} ` : "  "}
                  </text>
                  <text style={{ flexShrink: 0 }}>
                    {isSelected ? (
                      <b style={{ fg: nameColor }}>{shown}</b>
                    ) : (
                      <span style={{ fg: nameColor }}>{shown}</span>
                    )}
                  </text>
                </box>
              );
            })
          )}
        </box>

        <box style={{ height: 1, flexShrink: 0 }} />

        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          {error.length > 0 ? (
            <text style={{ fg: THEME.error, flexShrink: 0 }}>
              {clip(`${glyphs.error} ${error}`, inner - 12)}
            </text>
          ) : (
            <text style={{ fg: THEME.muted, flexShrink: 0 }}>{countLabel(model)}</text>
          )}
          <box style={{ flexGrow: 1 }} />
          {total > 0 ? (
            <text style={{ fg: THEME.muted, flexShrink: 0 }}>
              {`${String(selected + 1)} of ${String(total)}`}
            </text>
          ) : null}
        </box>
      </box>

      <HintRow
        hints={HINTS}
        width={width}
      />
    </box>
  );
}
