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
 *   - A masked value is replaced before it is measured or windowed. The
 *     prefix stays hidden (`***`) and only the last few characters are
 *     shown, so a pasted API key can be recognised without flashing the
 *     whole secret. A concealed value (a secret typed for the agent) shows
 *     one bullet per character and nothing of the value.
 *   - The value scrolls horizontally rather than wrapping. A wrapped input
 *     changes the height of the overlay as you type, which moves everything
 *     under the reader's hands; a fixed row does not.
 *   - The error row is always present, blank when there is nothing wrong, so
 *     a failed validation does not resize the card.
 */

import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import { OVERLAY_Z_INDEX } from "./centered";
import { BAND_CHROME_COLUMNS, bandStyle, overlayWidth, placeOverlay } from "./overlay-frame";
import { stepperSegments, type QuestionStep } from "./stepper";
import { getGlyphs } from "../../glyphs";
import { concealValue, maskSecret, maskSecretCaret } from "../../mask-secret";
import {
  clipTerminalCells,
  clipTerminalCellsFromStart,
  sliceTerminalCells,
  terminalCellWidth,
  terminalGraphemes,
} from "../../text/terminal-cells";
import { THEME } from "../../theme";
import type { Viewport } from "../types";

/** Border, blank, input, blank, error. */
const FIXED_CARD_ROWS = 6;

const HINT_ROWS = 1;

/** `» ` — the prompt marker and the space after it. */
const MARKER_COLUMN = 2;

/** A long question is worth a few rows; past that it is not a question. */
const MESSAGE_MAX_ROWS = 3;

export interface TextPromptModel {
  readonly kind: "text";
  readonly message: string;
  readonly value: string;
  /** Caret offset in characters. Equal to the length when it sits at the end. */
  readonly caret: number;
  /** Set for secrets: the prefix is masked before it is measured. */
  readonly masked?: boolean;
  /** Set for a secret the person types for the agent: every character is drawn as a bullet. */
  readonly concealed?: boolean;
  /** Shown only while the value is empty. */
  readonly placeholder?: string;
  /** The last validation failure, in prose. */
  readonly error?: string;
  /** Shown as a stepper row above the question. */
  readonly step?: QuestionStep;
}

function displayWidth(text: string): number {
  return terminalCellWidth(text);
}

function clip(text: string, width: number): string {
  return clipTerminalCells(text, width);
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
  const graphemes = terminalGraphemes(display);
  let index = 0;
  let codePoints = 0;
  while (index < graphemes.length) {
    const graphemeLength = [...(graphemes[index] as string)].length;
    if (codePoints + graphemeLength > caret) break;
    codePoints += graphemeLength;
    index += 1;
  }
  const at = graphemes[index] ?? " ";
  const atWidth = terminalCellWidth(at);
  const beforeBudget = Math.max(0, width - atWidth);
  const before = clipTerminalCellsFromStart(graphemes.slice(0, index).join(""), beforeBudget);
  const afterBudget = Math.max(0, width - terminalCellWidth(before) - atWidth);
  const after = sliceTerminalCells(graphemes.slice(index + 1).join(""), afterBudget);

  return {
    before,
    at,
    after,
  };
}

export interface CaretValueProps {
  readonly value: string;
  readonly caret: number;
  /** Columns the value may occupy. It scrolls inside them; it never wraps. */
  readonly width: number;
  readonly masked?: boolean;
  readonly concealed?: boolean;
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
  concealed,
  placeholder,
}: CaretValueProps): ReactNode {
  if (value.length === 0 && (placeholder ?? "").length > 0) {
    // The caret owns its cell and the placeholder starts one cell later, so the hint is read
    // whole instead of losing its first letter under the caret.
    const hint = clip(oneLine(placeholder ?? ""), Math.max(0, width - 1));
    return (
      <text style={{ flexShrink: 0 }}>
        <span style={{ fg: THEME.primary, attributes: TextAttributes.INVERSE }}> </span>
        <span style={{ fg: THEME.muted }}>{hint}</span>
      </text>
    );
  }

  const display =
    concealed === true ? concealValue(value) : masked === true ? maskSecret(value) : value;
  const displayCaret =
    concealed === true ? caret : masked === true ? maskSecretCaret(value, caret) : caret;
  const cells = caretCells(display, displayCaret, width);

  return (
    <text style={{ flexShrink: 0 }}>
      <span style={{ fg: THEME.selected }}>{cells.before}</span>
      <span style={{ fg: THEME.primary, attributes: TextAttributes.INVERSE }}>{cells.at}</span>
      <span style={{ fg: THEME.selected }}>{cells.after}</span>
    </text>
  );
}

/**
 * Split a value into rows of at most `width` cells, with the caret's grapheme
 * kept in the row that owns it. A trailing space is appended so a caret at the
 * end of the value has a cell to invert.
 */
export function wrapCaretRows(
  display: string,
  caret: number,
  width: number,
): { readonly rows: readonly CaretCells[]; readonly caretRow: number } {
  const budget = Math.max(1, width);
  const graphemes = [...terminalGraphemes(display), " "];
  const rowGraphemes: string[][] = [[]];
  const rowCells: number[] = [0];
  let caretGraphemeIndex = graphemes.length - 1;
  let codePoints = 0;
  let caretFound = false;
  graphemes.forEach((grapheme, index) => {
    if (!caretFound && codePoints + [...grapheme].length > caret) {
      caretGraphemeIndex = index;
      caretFound = true;
    }
    codePoints += [...grapheme].length;
    const cells = terminalCellWidth(grapheme);
    const last = rowGraphemes.length - 1;
    if ((rowCells[last] ?? 0) + cells > budget && (rowGraphemes[last]?.length ?? 0) > 0) {
      rowGraphemes.push([]);
      rowCells.push(0);
    }
    const target = rowGraphemes.length - 1;
    (rowGraphemes[target] as string[]).push(grapheme);
    rowCells[target] = (rowCells[target] ?? 0) + cells;
  });

  let seen = 0;
  let caretRow = rowGraphemes.length - 1;
  const rows = rowGraphemes.map((row, rowIndex) => {
    const caretInRow = caretGraphemeIndex - seen;
    if (caretInRow >= 0 && caretInRow < row.length) {
      caretRow = rowIndex;
      seen += row.length;
      return {
        before: row.slice(0, caretInRow).join(""),
        at: row[caretInRow] as string,
        after: row.slice(caretInRow + 1).join(""),
      };
    }
    seen += row.length;
    return { before: row.join(""), at: "", after: "" };
  });
  return { rows, caretRow };
}

export interface WrappedCaretValueProps {
  readonly value: string;
  readonly caret: number;
  /** Columns each row may occupy. The value wraps onto further rows. */
  readonly width: number;
  readonly placeholder?: string | undefined;
  /** Rows the value may occupy; the window follows the caret past it. */
  readonly maxRows: number;
}

/** Rows a wrapped value needs, so the parent can reserve the height before rendering. */
export function wrappedCaretRowCount(
  value: string,
  caret: number,
  width: number,
  maxRows: number,
): number {
  return Math.min(Math.max(1, maxRows), wrapCaretRows(value, caret, width).rows.length);
}

/**
 * The free-text answer row: the value wraps instead of scrolling sideways, so a
 * long answer stays readable in full. Rows beyond `maxRows` scroll with the caret.
 */
export function WrappedCaretValue({
  value,
  caret,
  width,
  placeholder,
  maxRows,
}: WrappedCaretValueProps): ReactNode {
  if (value.length === 0) {
    return (
      <CaretValue
        value={value}
        caret={caret}
        width={width}
        {...(placeholder === undefined ? {} : { placeholder })}
      />
    );
  }
  const { rows, caretRow } = wrapCaretRows(value, caret, width);
  const visibleRows = Math.min(Math.max(1, maxRows), rows.length);
  const windowStart = Math.max(0, Math.min(caretRow - visibleRows + 1, rows.length - visibleRows));
  return (
    <box style={{ flexDirection: "column", flexShrink: 0, height: visibleRows }}>
      {rows.slice(windowStart, windowStart + visibleRows).map((row, offset) => (
        <text
          key={windowStart + offset}
          style={{ flexShrink: 0 }}
        >
          <span style={{ fg: THEME.selected }}>{row.before}</span>
          <span style={{ fg: THEME.primary, attributes: TextAttributes.INVERSE }}>{row.at}</span>
          <span style={{ fg: THEME.selected }}>{row.after}</span>
        </text>
      ))}
    </box>
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
        backgroundColor: THEME.canvas,
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
  { key: "esc", label: "to go back", expendable: 0 },
];

export interface TextPromptProps {
  readonly model: TextPromptModel;
  readonly viewport: Viewport;
}

/** The card's size and placement; `height` is what the layout reserves. */
export function textPromptLayout(model: TextPromptModel, viewport: Viewport) {
  const frame = overlayWidth(viewport);
  const inner = Math.max(8, frame.width - BAND_CHROME_COLUMNS);
  const valueWidth = Math.max(4, inner - MARKER_COLUMN);
  const message = wrapProse(model.message, inner, MESSAGE_MAX_ROWS);
  // The stepper row and the blank that separates it from the question.
  const stepRows = model.step === undefined ? 0 : 2;
  const placement = placeOverlay(
    viewport,
    frame,
    FIXED_CARD_ROWS + stepRows + message.length + HINT_ROWS,
  );
  return {
    ...placement,
    inner,
    valueWidth,
    message,
    cardHeight: Math.max(1, placement.height - HINT_ROWS),
  };
}

export function TextPrompt({ model, viewport }: TextPromptProps): ReactNode {
  const glyphs = getGlyphs();
  const { width, inner, valueWidth, message, height, cardHeight, left, top } = textPromptLayout(
    model,
    viewport,
  );

  const error = oneLine(model.error ?? "");
  const stepper =
    model.step === undefined ? null : stepperSegments(model.step, inner, glyphs.success);

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
          // The band's padding rows stand where the old frame's top and bottom
          // edges were, so every row count below is unchanged.
          ...bandStyle(glyphs, THEME.surface, THEME.border),
          paddingTop: 1,
          paddingBottom: 1,
        }}
      >
        {stepper === null ? null : (
          <>
            <text style={{ height: 1, flexShrink: 0, wrapMode: "none", truncate: true }}>
              {stepper.map((part, index) =>
                part.bold === true ? (
                  <b
                    key={`step-${String(index)}`}
                    style={{ fg: part.fg }}
                  >
                    {part.text}
                  </b>
                ) : (
                  <span
                    key={`step-${String(index)}`}
                    style={{ fg: part.fg }}
                  >
                    {part.text}
                  </span>
                ),
              )}
            </text>
            <box style={{ height: 1, flexShrink: 0 }} />
          </>
        )}
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
            {...(model.concealed === true ? { concealed: true } : {})}
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
