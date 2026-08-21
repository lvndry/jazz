/** @jsxImportSource @opentui/react */

/**
 * The text overlay — `text`, `password` and `search`.
 *
 * A single line of typing, and the two things that make typing safe: you can
 * see where the caret is, and you can see why the last attempt was rejected.
 *
 *   - The caret is a reverse-video cell, not a glyph. A glyph caret has to be
 *     drawn from some font range, occupies a column the text also wants, and
 *     disappears against a block character; inverting the cell the caret is
 *     *on* costs nothing and cannot be confused with content.
 *   - A masked value never reaches the frame. The mask string is built from
 *     the value's length before anything is measured or windowed, so there is
 *     no code path on which a password character can be rendered — not even
 *     one clipped off the right edge, since clipping happens after masking.
 *   - The value scrolls horizontally rather than wrapping. A wrapped input
 *     changes the height of the overlay as you type, which moves everything
 *     under the reader's hands; a fixed row does not.
 *   - The error row is always present, blank when there is nothing wrong, so
 *     a failed validation does not resize the card.
 */

import { TextAttributes, type BorderCharacters } from "@opentui/core";
import type { ReactNode } from "react";
import { getGlyphs, type GlyphSet } from "../../glyphs";
import { THEME } from "../../theme";
import type { Viewport } from "../types";

const MAX_WIDTH = 76;
const MIN_WINDOWED_HEIGHT = 20;

const CARD_PAD = 1;

/** Border, blank, input, blank, error. */
const FIXED_CARD_ROWS = 6;

const HINT_ROWS = 1;

/** `» ` — the prompt marker and the space after it. */
const MARKER_COLUMN = 2;

/** A long question is worth a few rows; past that it is not a question. */
const MESSAGE_MAX_ROWS = 3;

const ELLIPSIS = "...";

export interface TextPromptModel {
  readonly kind: "text";
  readonly message: string;
  readonly value: string;
  /** Caret offset in characters. Equal to the length when it sits at the end. */
  readonly caret: number;
  /** Set for `password`: the characters are replaced before they are measured. */
  readonly masked?: boolean;
  /** Shown only while the value is empty. */
  readonly placeholder?: string;
  /** The last validation failure, in prose. */
  readonly error?: string;
}

function displayWidth(text: string): number {
  return [...text].length;
}

function clip(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = [...text];
  if (chars.length <= width) return text;
  if (width <= ELLIPSIS.length) return chars.slice(0, width).join("");
  return chars.slice(0, width - ELLIPSIS.length).join("") + ELLIPSIS;
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

/**
 * Replace every character of a value with the mask glyph.
 *
 * The mask comes from the glyph set rather than a literal, so it degrades to
 * `*` on a terminal we do not trust with Unicode. Length is preserved so the
 * caret still lands where the user thinks it is.
 */
function maskOf(value: string, glyphs: GlyphSet): string {
  return glyphs.bullet.repeat(displayWidth(value));
}

interface CaretCells {
  readonly before: string;
  readonly at: string;
  readonly after: string;
}

/**
 * Slide a window over the value so the caret is always in it, and split the
 * window at the caret so the middle cell can be inverted.
 *
 * The value is padded with one trailing space, because a caret at the end of
 * the value still needs a cell of its own to invert. Once the value is longer
 * than the row the window ends at the caret, and the elided head is written
 * *over* the first cells rather than prepended — so the row keeps its width
 * and the column it shares with the rest of the card stays aligned.
 */
function caretCells(display: string, caret: number, width: number): CaretCells {
  if (width <= 0) return { before: "", at: "", after: "" };
  const chars = [...display, " "];
  const index = Math.max(0, Math.min(caret, chars.length - 1));

  const from = Math.max(0, Math.min(index - width + 1, Math.max(0, chars.length - width)));
  const visible = chars.slice(from, from + width);
  const relative = Math.max(0, Math.min(index - from, visible.length - 1));
  const before = visible.slice(0, relative);
  if (from > 0) {
    for (let cell = 0; cell < ELLIPSIS.length && cell < before.length; cell++) {
      before[cell] = ELLIPSIS[cell] ?? ".";
    }
  }

  return {
    before: before.join(""),
    at: visible[relative] ?? " ",
    after: visible.slice(relative + 1).join(""),
  };
}

export interface CaretValueProps {
  readonly value: string;
  readonly caret: number;
  /** Columns the value may occupy. It scrolls inside them; it never wraps. */
  readonly width: number;
  readonly masked?: boolean;
  readonly placeholder?: string;
}

/**
 * One editable line: the value, the caret, and nothing else.
 *
 * Shared with the question overlay's "type your own" row, which is the same
 * object in a different frame.
 */
export function CaretValue({
  value,
  caret,
  width,
  masked,
  placeholder,
}: CaretValueProps): ReactNode {
  const glyphs = getGlyphs();

  if (value.length === 0 && (placeholder ?? "").length > 0) {
    const hint = clip(oneLine(placeholder ?? ""), width);
    const chars = [...hint];
    return (
      <text style={{ flexShrink: 0 }}>
        <span style={{ fg: THEME.muted, attributes: TextAttributes.INVERSE }}>
          {chars[0] ?? " "}
        </span>
        <span style={{ fg: THEME.muted }}>{chars.slice(1).join("")}</span>
      </text>
    );
  }

  // Masking happens first: nothing downstream of here has the real value.
  const display = masked === true ? maskOf(value, glyphs) : value;
  const cells = caretCells(display, caret, width);

  return (
    <text style={{ flexShrink: 0 }}>
      <span style={{ fg: THEME.selected }}>{cells.before}</span>
      <span style={{ fg: THEME.primary, attributes: TextAttributes.INVERSE }}>{cells.at}</span>
      <span style={{ fg: THEME.selected }}>{cells.after}</span>
    </text>
  );
}

export interface Hint {
  readonly key: string;
  readonly label: string;
  /**
   * Which keys are the first to go when the row is narrower than the whole
   * legend. Escape is never expendable; a key you can guess from the arrow
   * cluster is the most expendable thing on the line.
   */
  readonly expendable: number;
}

/** Four spaces: enough that two key/label pairs cannot be read as one. */
const HINT_GAP = 4;

/** The keys line is inset one column further than the frame, so it hangs free. */
const HINT_PAD = 2;

function hintsWidth(hints: readonly Hint[]): number {
  return hints.reduce(
    (total, hint, index) =>
      total + (index > 0 ? HINT_GAP : 0) + displayWidth(hint.key) + 1 + displayWidth(hint.label),
    0,
  );
}

/**
 * Drop the most expendable keys until the legend fits.
 *
 * A clipped legend is worse than a shorter one: clipping takes the *last*
 * hint, which is always escape — the one key a user stuck in a modal needs to
 * find. So the row sheds hints it can afford to lose instead.
 */
function fitHints(hints: readonly Hint[], budget: number): readonly Hint[] {
  const kept = [...hints];
  while (kept.length > 1 && hintsWidth(kept) > budget) {
    let worst = 0;
    for (let index = 1; index < kept.length; index++) {
      if ((kept[index]?.expendable ?? 0) > (kept[worst]?.expendable ?? 0)) worst = index;
    }
    kept.splice(worst, 1);
  }
  return kept;
}

export interface HintRowProps {
  readonly hints: readonly Hint[];
  /** The overlay's full width; the row insets itself inside it. */
  readonly width: number;
  /** A count or a position, flush right. Dropped before any key is. */
  readonly tally?: string;
}

/**
 * The keys line, beneath the frame.
 *
 * Shared by all three prompts, because they are the same object: the frame is
 * the question, and this row is what you can do about it.
 */
export function HintRow({ hints, width, tally }: HintRowProps): ReactNode {
  const budget = Math.max(1, width - HINT_PAD * 2);
  const kept = fitHints(hints, budget);
  const showTally =
    tally !== undefined &&
    tally.length > 0 &&
    hintsWidth(kept) + HINT_GAP + displayWidth(tally) <= budget;

  return (
    <box
      style={{
        height: HINT_ROWS,
        flexShrink: 0,
        flexDirection: "row",
        paddingLeft: HINT_PAD,
        paddingRight: HINT_PAD,
      }}
    >
      <text style={{ flexShrink: 0 }}>
        {kept.flatMap((hint, index) => [
          ...(index > 0
            ? [
                <span
                  key={`${hint.key}-gap`}
                  style={{ fg: THEME.muted }}
                >
                  {" ".repeat(HINT_GAP)}
                </span>,
              ]
            : []),
          <b
            key={`${hint.key}-key`}
            style={{ fg: THEME.selected }}
          >
            {hint.key}
          </b>,
          <span
            key={`${hint.key}-label`}
            style={{ fg: THEME.secondary }}
          >
            {` ${hint.label}`}
          </span>,
        ])}
      </text>
      <box style={{ flexGrow: 1 }} />
      {showTally ? <text style={{ fg: THEME.muted, flexShrink: 0 }}>{tally}</text> : null}
    </box>
  );
}

const HINTS: readonly Hint[] = [
  { key: "enter", label: "submit", expendable: 1 },
  { key: "esc", label: "cancel", expendable: 0 },
];

export interface TextPromptProps {
  readonly model: TextPromptModel;
  readonly viewport: Viewport;
}

export function TextPrompt({ model, viewport }: TextPromptProps): ReactNode {
  const glyphs = getGlyphs();

  const fullscreen = viewport.width < MAX_WIDTH || viewport.height < MIN_WINDOWED_HEIGHT;
  const width = fullscreen ? viewport.width : Math.min(MAX_WIDTH, viewport.width - 4);
  const inner = Math.max(8, width - 2 - CARD_PAD * 2);
  const valueWidth = Math.max(4, inner - MARKER_COLUMN);

  const message = wrapProse(model.message, inner, MESSAGE_MAX_ROWS);
  const windowedHeight = FIXED_CARD_ROWS + message.length + HINT_ROWS;
  const height = fullscreen ? viewport.height : Math.min(windowedHeight, viewport.height);
  const cardHeight = Math.max(1, height - HINT_ROWS);

  const left = fullscreen ? 0 : Math.max(0, Math.floor((viewport.width - width) / 2));
  const top = fullscreen ? 0 : Math.max(0, Math.floor((viewport.height - height) / 2));

  const error = oneLine(model.error ?? "");

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
          <CaretValue
            value={model.value}
            caret={model.caret}
            width={valueWidth}
            {...(model.masked === true ? { masked: true } : {})}
            {...(model.placeholder === undefined ? {} : { placeholder: model.placeholder })}
          />
        </box>

        <box style={{ height: 1, flexShrink: 0 }} />

        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          {error.length > 0 ? (
            <text style={{ fg: THEME.error, flexShrink: 0 }}>
              {clip(`${glyphs.error} ${error}`, inner)}
            </text>
          ) : null}
        </box>
      </box>

      <HintRow
        hints={HINTS}
        width={width}
        {...(model.masked === true ? { tally: "hidden while you type" } : {})}
      />
    </box>
  );
}
