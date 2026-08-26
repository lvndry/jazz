/** @jsxImportSource @opentui/react */

/**
 * The question overlay — `select`, `confirm`, `checkbox` and `questionnaire`.
 *
 * This is the most common interactive object in the product: the agent has to
 * ask something before it can continue, and until it is answered nothing else
 * happens. So it is built to be answered without reading it twice.
 *
 *   - The label and its description share a row when they fit, with the
 *     descriptions aligned into a column so the set reads as a table rather
 *     than as a paragraph per option. When either overflows it wraps in place
 *     — the whole suggestion stays on screen, never hidden behind an ellipsis.
 *   - Selection is a rail in the gutter plus the label's weight. No background
 *     wash, because a wash on a 256-colour terminal is a guess about the
 *     user's own background, and because a rail survives monochrome.
 *   - Checkbox state is a bracketed mark, which is a second channel: what is
 *     *checked* is independent of what is *focused*, so the two cannot be
 *     confused the way one highlight colour doing both jobs would be.
 *   - The quick-pick numbers stay on the neutral ramp. Position never carries
 *     meaning, so it never earns a hue.
 *   - The keys live on a line outside the frame. The frame is the question;
 *     the line below it is what you can do about it.
 */

import type { BorderCharacters } from "@opentui/core";
import type { ReactNode } from "react";
import { getGlyphs, type GlyphSet } from "../../glyphs";
import { PICKER_WINDOW_SIZE, pickerWindowStart } from "../../picker-window";
import { THEME } from "../../theme";
import { clipTerminalCells, terminalCellWidth, wrapTerminalCells } from "../terminal-cells";
import { centeredOffset } from "./centered";
import type { Viewport } from "../types";
import { CaretValue, HintRow, type Hint } from "./TextPrompt";

/** Windowed width, and the floor below which windowing stops making sense. */
const MAX_WIDTH = 96;
const MIN_WINDOWED_HEIGHT = 20;

/** One column of breathing room inside the frame, on each side. */
const CARD_PAD = 1;

/** Border, blank above the list, blank below it. */
const FIXED_CARD_ROWS = 4;

/** The keys line, beneath the frame. */
const HINT_ROWS = 1;

/** Rail, space. The gutter every row shares. */
const GUTTER = 2;

/** `10 ` — two digits plus a space, so the tenth visible row stays aligned. */
const NUMBER_COLUMN = 3;

/** `[x] ` — the checkbox mark and the space after it. */
const CHECKBOX_COLUMN = 4;

/** Descriptions never take more of the row than the labels they annotate. */
const DESCRIPTION_SHARE = 0.55;

/** Two spaces between a label and its description, so the column reads as one. */
const DESCRIPTION_GAP = 2;

/** A long question is worth two rows; past that it is not a question. */
const MESSAGE_MAX_ROWS = 3;

/** Keep this much context past the selection before the list starts to follow it. */
const LIST_MARGIN = 1;

/** The custom row says what it is for, in the house voice, rather than "Other". */
const CUSTOM_HINT = "Type your own answer";
const FILTER_PLACEHOLDER = "Type to filter";

export type QuestionMode = "select" | "checkbox";

export interface QuestionChoice {
  readonly label: string;
  /** Stable identity, used for the checked set and for the resolved answer. */
  readonly value: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface QuestionModel {
  readonly kind: "question";
  /** `select` and `confirm` are single-answer; `checkbox` accumulates. */
  readonly mode: QuestionMode;
  readonly message: string;
  readonly choices: readonly QuestionChoice[];
  /** Index into `choices`, or `choices.length` for the custom row. */
  readonly selected: number;
  /** Checked choice values. Read as a set; order is not significant. */
  readonly checked?: readonly string[];
  /** Adds a final row the user can type their own answer into. */
  readonly allowCustom?: boolean;
  /** The custom row's text. Only rendered while that row is selected. */
  readonly customValue?: string;
  readonly customCaret?: number;
  /** Incremental filter shown on a row under the question. */
  readonly filter?: string;
  /** When set, typing filters the list and an empty match is not a custom row. */
  readonly filterable?: boolean;
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
  const lines = wrapLines(text, width);
  if (lines.length <= maxRows) return lines;
  const kept = lines.slice(0, maxRows);
  const last = kept[maxRows - 1] ?? "";
  kept[maxRows - 1] = clip(`${last} ${lines.slice(maxRows).join(" ")}`, width);
  return kept;
}

/** Word-wrap, then hard-wrap leftover words. Never ellipsizes. */
function wrapLines(text: string, width: number): string[] {
  const budget = Math.max(1, width);
  const words = oneLine(text)
    .split(" ")
    .filter((word) => word.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (displayWidth(candidate) <= budget) {
      line = candidate;
      continue;
    }
    if (line.length > 0) lines.push(line);
    if (displayWidth(word) <= budget) {
      line = word;
      continue;
    }
    const pieces = wrapTerminalCells(word, budget);
    lines.push(...pieces.slice(0, -1));
    line = pieces[pieces.length - 1] ?? "";
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

interface ChoiceLayout {
  readonly labelLines: readonly string[];
  readonly descriptionLines: readonly string[];
  readonly rows: number;
}

function layoutChoice(
  choice: QuestionChoice | null,
  labelWidth: number,
  descriptionWidth: number,
): ChoiceLayout {
  if (choice === null) return { labelLines: [""], descriptionLines: [], rows: 1 };
  const labelLines = wrapLines(oneLine(choice.label), labelWidth);
  const descriptionLines =
    descriptionWidth > 0 && (choice.description ?? "").length > 0
      ? wrapLines(oneLine(choice.description ?? ""), descriptionWidth)
      : [];
  return {
    labelLines,
    descriptionLines,
    rows: Math.max(labelLines.length, descriptionLines.length, 1),
  };
}

function windowStartForRows(heights: readonly number[], selected: number, rows: number): number {
  const total = heights.reduce((sum, height) => sum + height, 0);
  if (total <= rows) return 0;
  let start = 0;
  while (start < selected) {
    const untilSelected = heights
      .slice(start, selected + 1)
      .reduce((sum, height) => sum + height, 0);
    const margin = heights
      .slice(selected + 1, selected + 1 + LIST_MARGIN)
      .reduce((sum, height) => sum + height, 0);
    if (untilSelected + margin <= rows) break;
    start += 1;
  }
  return start;
}

function windowChoiceNumber(offset: number): string {
  return `${String(offset + 1).padStart(NUMBER_COLUMN - 1)} `;
}

function takeVisible<Item>(
  items: readonly Item[],
  heights: readonly number[],
  start: number,
  rows: number,
): readonly Item[] {
  const visible: Item[] = [];
  let used = 0;
  for (let index = start; index < items.length; index += 1) {
    const height = heights[index] ?? 1;
    if (visible.length > 0 && used + height > rows) break;
    const item = items[index];
    if (item === undefined) break;
    visible.push(item);
    used += height;
    if (used >= rows) break;
  }
  return visible;
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

export interface QuestionProps {
  readonly model: QuestionModel;
  readonly viewport: Viewport;
}

export function Question({ model, viewport }: QuestionProps): ReactNode {
  const glyphs = getGlyphs();

  const fullscreen = viewport.width < MAX_WIDTH || viewport.height < MIN_WINDOWED_HEIGHT;
  const width = fullscreen ? viewport.width : Math.min(MAX_WIDTH, viewport.width - 4);
  const inner = Math.max(8, width - 2 - CARD_PAD * 2);

  const filterable = model.filterable === true;
  // With no choices at all the user would otherwise be stuck looking at a
  // question they cannot answer, so the custom row appears regardless — unless
  // this is a filtered list, where empty means "no matches".
  const custom = model.allowCustom === true || (model.choices.length === 0 && !filterable);
  const checkbox = model.mode === "checkbox";
  const checked = new Set(model.checked ?? []);

  const message = wrapProse(model.message, Math.max(4, inner - GUTTER), MESSAGE_MAX_ROWS);
  const total = model.choices.length + (custom ? 1 : 0);
  const selected = Math.max(0, Math.min(model.selected, Math.max(0, total - 1)));

  // Descriptions align into their own column so the choices read as a table.
  // Labels keep the majority of the row: the label is the answer, the
  // description is only the reason for it.
  const markColumn = GUTTER + NUMBER_COLUMN + (checkbox ? CHECKBOX_COLUMN : 0);
  const bodyWidth = Math.max(4, inner - markColumn);
  const described = model.choices.some((choice) => (choice.description ?? "").length > 0);
  const longestLabel = model.choices.reduce(
    (widest, choice) => Math.max(widest, displayWidth(oneLine(choice.label))),
    0,
  );
  const labelWidth = described
    ? Math.max(4, Math.min(longestLabel, Math.floor(bodyWidth * (1 - DESCRIPTION_SHARE))))
    : bodyWidth;
  const descriptionWidth = described ? Math.max(0, bodyWidth - labelWidth - DESCRIPTION_GAP) : 0;

  // The custom row is the last item in one list, not a separate region — so it
  // scrolls with everything else and the arithmetic stays in one place.
  const items: readonly (QuestionChoice | null)[] = custom
    ? [...model.choices, null]
    : model.choices;
  const layouts = items.map((choice) => layoutChoice(choice, labelWidth, descriptionWidth));
  const heights = layouts.map((layout) => layout.rows);

  const filterRows = filterable ? 1 : 0;
  const fixedRows = FIXED_CARD_ROWS + message.length + filterRows;
  const pageStart = pickerWindowStart(selected, items.length, PICKER_WINDOW_SIZE);
  const pageCount = Math.min(PICKER_WINDOW_SIZE, items.length);
  const pageHeights = heights.slice(pageStart, pageStart + pageCount);
  const desiredListRows = Math.max(1, pageHeights.reduce((sum, rows) => sum + rows, 0) || 1);
  const maxListRows = Math.max(1, viewport.height - HINT_ROWS - fixedRows);
  const listRows = Math.min(desiredListRows, maxListRows);
  const selectedInPage = Math.max(0, selected - pageStart);
  const startInPage = windowStartForRows(pageHeights, selectedInPage, listRows);
  const pageItems = items.slice(pageStart, pageStart + pageCount);
  const visible = takeVisible(pageItems, pageHeights, startInPage, listRows);
  const start = pageStart + startInPage;

  // The option block hangs centered in the card: its widest visible row defines
  // the block, and the leftover width becomes symmetric padding. The title stays
  // left-aligned — only the answers float.
  const widestOptionRow = visible.reduce((widest, choice, offset) => {
    const index = start + offset;
    if (choice === null) {
      return Math.max(widest, GUTTER + NUMBER_COLUMN + displayWidth(CUSTOM_HINT));
    }
    const layout = layouts[index] ?? layoutChoice(choice, labelWidth, descriptionWidth);
    const description = layout.descriptionLines[0] ?? "";
    return Math.max(
      widest,
      GUTTER +
        NUMBER_COLUMN +
        displayWidth(layout.labelLines[0] ?? "") +
        (description.length > 0 ? DESCRIPTION_GAP + displayWidth(description) : 0),
    );
  }, 0);
  const listOffset =
    filterable || widestOptionRow >= inner ? 0 : centeredOffset(widestOptionRow, inner);

  const windowedHeight = fixedRows + listRows + HINT_ROWS;
  const height = fullscreen ? viewport.height : Math.min(windowedHeight, viewport.height);
  const cardHeight = Math.max(1, height - HINT_ROWS);

  const left = fullscreen ? 0 : Math.max(0, Math.floor((viewport.width - width) / 2));
  const top = fullscreen ? 0 : Math.max(0, viewport.height - height);

  const hints: readonly Hint[] = checkbox
    ? [
        { key: "up/down", label: "move", expendable: 3 },
        { key: "space", label: "toggle", expendable: 2 },
        { key: "enter", label: "submit", expendable: 1 },
        { key: "esc", label: "cancel", expendable: 0 },
      ]
    : filterable
      ? [
          { key: "up/down", label: "choose", expendable: 3 },
          { key: "type", label: "filter", expendable: 2 },
          { key: "enter", label: "select", expendable: 1 },
          { key: "esc", label: "cancel", expendable: 0 },
        ]
      : [
          { key: "up/down", label: "move", expendable: 3 },
          { key: "enter", label: "select", expendable: 1 },
          { key: "esc", label: "cancel", expendable: 0 },
        ];

  const tally = checkbox
    ? `${String(checked.size)} selected`
    : total === 0
      ? "no matches"
      : `${String(selected + 1)} of ${String(total)}`;

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
          <box
            key={`message-${String(index)}`}
            style={{ height: 1, flexShrink: 0, flexDirection: "row" }}
          >
            <text style={{ fg: THEME.muted, width: GUTTER, flexShrink: 0 }}>
              {index === 0 ? `${glyphs.question} ` : " ".repeat(GUTTER)}
            </text>
            <text style={{ fg: THEME.selected }}>{line}</text>
          </box>
        ))}

        {filterable ? (
          <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
            <text style={{ fg: THEME.primary, width: GUTTER, flexShrink: 0 }}>
              {`${glyphs.promptCursor} `}
            </text>
            <text
              style={{
                fg: (model.filter ?? "").length > 0 ? THEME.selected : THEME.muted,
                flexShrink: 0,
              }}
            >
              {clip(
                oneLine(
                  (model.filter ?? "").length > 0 ? (model.filter ?? "") : FILTER_PLACEHOLDER,
                ),
                Math.max(4, inner - GUTTER),
              )}
            </text>
          </box>
        ) : null}

        <box style={{ height: 1, flexShrink: 0 }} />

        <box
          style={{
            height: listRows,
            flexShrink: 0,
            flexDirection: "column",
            paddingLeft: listOffset,
          }}
        >
          {filterable && items.length === 0 ? (
            <text style={{ fg: THEME.muted, height: 1, flexShrink: 0 }}>No matching options</text>
          ) : (
            visible.map((choice, offset) => {
              const index = start + offset;
              const isSelected = index === selected;
              const remaining = heights
                .slice(start, index)
                .reduce((left, rows) => left - rows, listRows);
              const shownRows = Math.max(1, Math.min(layouts[index]?.rows ?? 1, remaining));

              if (choice === null) {
                return (
                  <box
                    key="custom"
                    style={{ height: 1, flexShrink: 0, flexDirection: "row" }}
                  >
                    <text style={{ fg: THEME.primary, width: GUTTER, flexShrink: 0 }}>
                      {isSelected ? `${glyphs.rail} ` : " ".repeat(GUTTER)}
                    </text>
                    <text style={{ fg: THEME.primary, width: NUMBER_COLUMN, flexShrink: 0 }}>
                      {`${glyphs.promptCursor} `}
                    </text>
                    {isSelected ? (
                      <CaretValue
                        value={model.customValue ?? ""}
                        caret={model.customCaret ?? displayWidth(model.customValue ?? "")}
                        width={Math.max(4, inner - GUTTER - NUMBER_COLUMN)}
                        placeholder={CUSTOM_HINT}
                      />
                    ) : (
                      <text style={{ fg: THEME.muted, flexShrink: 0 }}>
                        {clip(CUSTOM_HINT, Math.max(4, inner - GUTTER - NUMBER_COLUMN))}
                      </text>
                    )}
                  </box>
                );
              }

              const isChecked = checked.has(choice.value);
              const disabled = choice.disabled === true;
              const labelColor = disabled
                ? THEME.muted
                : isSelected
                  ? THEME.selected
                  : THEME.secondary;
              const layout = layouts[index] ?? layoutChoice(choice, labelWidth, descriptionWidth);
              const labelLines = layout.labelLines.slice(0, shownRows);
              const descriptionLines = layout.descriptionLines.slice(0, shownRows);
              return (
                <box
                  key={choice.value}
                  style={{ height: shownRows, flexShrink: 0, flexDirection: "column" }}
                >
                  {Array.from({ length: shownRows }, (_, row) => {
                    const label = labelLines[row] ?? "";
                    const description = descriptionLines[row] ?? "";
                    return (
                      <box
                        key={`${choice.value}-${String(row)}`}
                        style={{ height: 1, flexShrink: 0, flexDirection: "row" }}
                      >
                        <text style={{ fg: THEME.primary, width: GUTTER, flexShrink: 0 }}>
                          {isSelected ? `${glyphs.rail} ` : " ".repeat(GUTTER)}
                        </text>
                        <text style={{ fg: THEME.muted, width: NUMBER_COLUMN, flexShrink: 0 }}>
                          {row === 0 ? windowChoiceNumber(offset) : " ".repeat(NUMBER_COLUMN)}
                        </text>
                        {checkbox ? (
                          <text style={{ width: CHECKBOX_COLUMN, flexShrink: 0 }}>
                            {row === 0 ? (
                              <>
                                <span style={{ fg: THEME.muted }}>[</span>
                                <span style={{ fg: isChecked ? THEME.primary : THEME.muted }}>
                                  {isChecked ? glyphs.success : " "}
                                </span>
                                <span style={{ fg: THEME.muted }}>{"] "}</span>
                              </>
                            ) : (
                              " ".repeat(CHECKBOX_COLUMN)
                            )}
                          </text>
                        ) : null}
                        <text style={{ width: labelWidth, flexShrink: 0 }}>
                          {isSelected ? (
                            <b style={{ fg: labelColor }}>{label}</b>
                          ) : (
                            <span style={{ fg: labelColor }}>{label}</span>
                          )}
                        </text>
                        {descriptionWidth > 0 ? (
                          <text style={{ fg: THEME.muted, flexShrink: 0 }}>
                            {`${" ".repeat(DESCRIPTION_GAP)}${description}`}
                          </text>
                        ) : null}
                      </box>
                    );
                  })}
                </box>
              );
            })
          )}
        </box>

        <box style={{ height: 1, flexShrink: 0 }} />
      </box>

      <HintRow
        hints={hints}
        width={width}
        tally={tally}
      />
    </box>
  );
}
