/** @jsxImportSource @opentui/react */

/**
 * The approval overlay.
 *
 * A coding agent asks to edit a file you can revert. Jazz asks to send an
 * email, write to a calendar, or post where other people read it — and there
 * is no undo for any of those. So this object breaks the visual language in
 * exactly one deliberate way: it is elevated onto a `surface` panel behind a
 * frame, marked with the `proposed` glyph that appears nowhere else in the
 * product. Everything else about it is quiet on purpose.
 *
 *   - The real account is rendered verbatim, because the whole trust argument
 *     is that jazz always says which real-world object is in scope.
 *   - Every field that will exist afterwards is on screen before you commit.
 *     Nothing is discoverable only after pressing enter.
 *   - Irreversibility is stated in prose, not encoded in an icon.
 *   - Red is reserved for things that already broke; this is a decision being
 *     offered, so the only hue is `warning`, on the marker and the verb.
 *   - It holds perfectly still. No spinner, no pulse, no countdown: motion
 *     here would be pressure applied to an irreversible choice.
 *   - The controls sit outside the frame. The card is what *will happen*; the
 *     line below it is what *you can do*.
 */

import { TextAttributes, type BorderCharacters } from "@opentui/core";
import type { ReactNode } from "react";
import { getGlyphs, type GlyphSet } from "../../glyphs";
import { THEME } from "../../theme";
import { clipTerminalCells, terminalCellWidth } from "../terminal-cells";
import type { ApprovalOverlay, Viewport } from "../types";

/** Windowed width, and the floor below which windowing stops making sense. */
const MAX_WIDTH = 76;
const MIN_WINDOWED_HEIGHT = 20;

/** One column of breathing room inside the frame, on each side. */
const CARD_PAD = 1;

/** Labels share a column so the values line up and read as a record. */
const LABEL_COLUMN = 11;

/** Border, header, blank, account, rule, blank, border. */
const FIXED_CARD_ROWS = 7;

/** The controls line, beneath the frame. */
const CONTROL_ROWS = 1;

function displayWidth(text: string): number {
  return terminalCellWidth(text);
}

function clip(text: string, width: number): string {
  return clipTerminalCells(text, width);
}

/** A field value is one row of a record, so newlines collapse rather than wrap. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function wrapProse(text: string, width: number): string[] {
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
  return lines.length > 0 ? lines : [""];
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

export interface ApprovalProps {
  readonly model: ApprovalOverlay;
  readonly viewport: Viewport;
}

export function Approval({ model, viewport }: ApprovalProps): ReactNode {
  const glyphs = getGlyphs();

  // Below the windowed size a centred panel is mostly frame, so the overlay
  // takes the whole viewport instead of drawing a cramped card.
  const fullscreen = viewport.width < MAX_WIDTH || viewport.height < MIN_WINDOWED_HEIGHT;
  const width = fullscreen ? viewport.width : Math.min(MAX_WIDTH, viewport.width - 4);
  const inner = Math.max(8, width - 2 - CARD_PAD * 2);
  const valueWidth = Math.max(4, inner - LABEL_COLUMN);

  const consequence = wrapProse(model.consequence, inner);
  const fixedRows = FIXED_CARD_ROWS + consequence.length;
  const windowedHeight = fixedRows + model.fields.length + CONTROL_ROWS;
  const height = fullscreen ? viewport.height : Math.min(windowedHeight, viewport.height);
  const cardHeight = Math.max(1, height - CONTROL_ROWS);

  // Every field is on screen before you commit — so when the viewport cannot
  // hold them all the region scrolls rather than the list being cut short.
  const fieldRows = Math.max(1, cardHeight - fixedRows);
  const fieldsScroll = fieldRows < model.fields.length;
  const maxFieldOffset = Math.max(0, model.fields.length - fieldRows);
  const fieldOffset = Math.max(0, Math.min(model.fieldOffset ?? 0, maxFieldOffset));
  const visibleFields = model.fields.slice(fieldOffset, fieldOffset + fieldRows);

  const left = fullscreen ? 0 : Math.max(0, Math.floor((viewport.width - width) / 2));
  const top = fullscreen ? 0 : Math.max(0, Math.floor((viewport.height - height) / 2));

  const fieldRowsContent = visibleFields.map((field, index) => (
    <box
      key={`${String(fieldOffset + index)}:${field.label}`}
      style={{ height: 1, flexShrink: 0, flexDirection: "row" }}
    >
      <text style={{ fg: THEME.muted, width: LABEL_COLUMN, flexShrink: 0 }}>
        {clip(oneLine(field.label), LABEL_COLUMN - 1)}
      </text>
      <text style={{ fg: THEME.selected }}>{clip(oneLine(field.value), valueWidth)}</text>
    </box>
  ));

  return (
    <box
      style={{
        position: "absolute",
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
        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          <text style={{ fg: THEME.warning }}>
            <span style={{ fg: THEME.warning }}>{`${glyphs.proposed} `}</span>
            <span style={{ fg: THEME.warning }}>{clip(model.action, inner - 2)}</span>
          </text>
          <box style={{ flexGrow: 1 }} />
          <text style={{ fg: THEME.muted, flexShrink: 0 }}>{clip(model.app, inner)}</text>
        </box>

        <box style={{ height: 1, flexShrink: 0 }} />

        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          <text style={{ fg: THEME.muted, width: LABEL_COLUMN, flexShrink: 0 }}>Account</text>
          <text style={{ fg: THEME.selected }}>{clip(model.account, valueWidth)}</text>
        </box>

        <text style={{ fg: THEME.border, height: 1, flexShrink: 0 }}>
          {glyphs.divider.repeat(inner)}
        </text>

        <box style={{ height: fieldRows, flexShrink: 0, flexDirection: "column" }}>
          {fieldRowsContent}
        </box>

        <box style={{ height: 1, flexShrink: 0 }} />

        {consequence.map((line, index) => (
          <text
            key={`consequence-${String(index)}`}
            style={{ fg: THEME.secondary, height: 1, flexShrink: 0 }}
          >
            {line}
          </text>
        ))}
      </box>

      <box
        style={{
          height: CONTROL_ROWS,
          flexShrink: 0,
          flexDirection: "row",
          paddingLeft: CARD_PAD + 1,
          paddingRight: CARD_PAD + 1,
        }}
      >
        <text>
          {model.armed ? (
            <b style={{ fg: THEME.primary }}>enter</b>
          ) : (
            <span style={{ fg: THEME.secondary, attributes: TextAttributes.DIM }}>enter</span>
          )}
          <span style={{ fg: THEME.secondary }}>{" accept"}</span>
          <span style={{ fg: THEME.muted }}>{"    "}</span>
          <b style={{ fg: THEME.selected }}>esc</b>
          <span style={{ fg: THEME.secondary }}>{" reject"}</span>
        </text>
        <box style={{ flexGrow: 1 }} />
        <text style={{ fg: THEME.muted, flexShrink: 0 }}>
          {clip(
            `${fieldsScroll ? "up/down fields · " : ""}a ${model.alwaysLabel}`,
            Math.max(0, inner - 27),
          )}
        </text>
      </box>
    </box>
  );
}
