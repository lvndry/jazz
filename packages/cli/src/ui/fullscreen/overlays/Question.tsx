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
 *   - The selected row lifts onto the element tier with the accent `›` in the
 *     gutter and the label in bold, so selection reads by weight and by plane
 *     and still survives monochrome through the marker.
 *   - A question carries the accent bar; an approval carries the warning bar.
 *     "Which one?" must never look like "may I?".
 *   - A yes/no question is two buttons, the selected one filled with the
 *     accent, and y / n answer without moving the selection.
 *   - The last row is always a way to answer in your own words, so the agent's
 *     framing is never the only option.
 *   - Checkbox state is a bracketed mark, which is a second channel: what is
 *     *checked* is independent of what is *focused*, so the two cannot be
 *     confused the way one highlight colour doing both jobs would be.
 *   - The quick-pick numbers stay on the neutral ramp. Position never carries
 *     meaning, so it never earns a hue.
 *   - The keys live on a line outside the frame. The frame is the question;
 *     the line below it is what you can do about it.
 */

import type { ChoicePreviewLine } from "@jazz/core/interfaces/terminal";
import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import { centeredOffset, OVERLAY_Z_INDEX } from "./centered";
import { BAND_CHROME_COLUMNS, bandStyle, overlayWidth, placeOverlay } from "./overlay-frame";
import { stepperSegments, type QuestionStep } from "./stepper";
import { CaretValue, HintRow, type Hint } from "./TextPrompt";
import { getGlyphs } from "../../glyphs";
import { CUSTOM_ANSWER_LABEL, questionKeys, questionPositionLabel } from "../../models/question";
import { alignTabColumns } from "../../prompt-core/description-columns";
import { PICKER_WINDOW_SIZE, pickerWindowStart } from "../../text/picker-window";
import { clipTerminalCells, terminalCellWidth, wrapTerminalCells } from "../../text/terminal-cells";
import { THEME } from "../../theme";
import type { Viewport } from "../types";

/** Windowed width, and the floor below which windowing stops making sense. */

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
const CUSTOM_HINT = CUSTOM_ANSWER_LABEL;

/** Cells either side of a button's label, inside its fill. */
const BUTTON_PAD = 1;

/** Cells between the two buttons. */
const BUTTON_GAP = 3;

/** Share of the inner width a preview pane takes when any choice carries one. */
const PREVIEW_SHARE = 0.4;

/** Cells between the list and the preview pane. */
const PREVIEW_GAP = 3;

/** The preview pane never drops below this width; below it, it is not worth showing. */
const PREVIEW_MIN_WIDTH = 12;

/** Relative luminance above which text on the accent reads best dark. */
const LIGHT_ACCENT_LUMINANCE = 0.45;

/** Text on an accent fill: near-black on a light accent, white on a dark one. */
export function onAccent(accent: string): string {
  const match = /^#([0-9A-Fa-f]{6})$/.exec(accent);
  if (match === null) return THEME.selected;
  const value = Number.parseInt(match[1] ?? "0", 16);
  const channel = (shift: number): number => {
    const unit = ((value >> shift) & 255) / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > LIGHT_ACCENT_LUMINANCE ? "#0A0A0A" : "#FFFFFF";
}
const FILTER_PLACEHOLDER = "Type to filter";

export type QuestionMode = "select" | "checkbox";

/** How a choice's tag reads: its readiness, a consequence, or plain information. */
export type QuestionTagTone = "success" | "warning" | "accent" | "muted";

export interface QuestionChoice {
  readonly label: string;
  /** Stable identity, used for the checked set and for the resolved answer. */
  readonly value: string;
  readonly description?: string;
  readonly disabled?: boolean;
  /** A short state flush right on the row: "key saved", "asks first". */
  readonly tag?: string;
  readonly tagTone?: QuestionTagTone;
  /** Rendered live in a pane to the right of the list while this choice is highlighted. */
  readonly preview?: readonly ChoicePreviewLine[];
}

/** Descriptions with tab-separated columns, lined up across the choices by the shared picker rule. */
export function alignDescriptionColumns(
  choices: readonly QuestionChoice[],
): readonly QuestionChoice[] {
  const aligned = alignTabColumns(choices.map((choice) => choice.description));
  if (aligned.every((description, index) => description === choices[index]?.description)) {
    return choices;
  }
  return choices.map((choice, index) => {
    const description = aligned[index];
    return description === undefined ? choice : { ...choice, description };
  });
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
  /** Caret offset into `filter`, in characters. */
  readonly filterCaret?: number;
  /** When set, typing filters the list and an empty match is not a custom row. */
  readonly filterable?: boolean;
  /** Two choices drawn as buttons on one row: a yes/no question. */
  readonly buttons?: boolean;
  /** Where this question sits in a run of questions asked together: `1 of 2`. */
  readonly position?: { readonly index: number; readonly total: number };
  /** Esc skips a question the agent asked; it cancels a menu jazz itself opened. */
  readonly skippable?: boolean;
  /** Shown as a stepper row above the question. */
  readonly step?: QuestionStep;
}

function tagColor(tone: QuestionTagTone | undefined): string {
  switch (tone) {
    case "success":
      return THEME.success;
    case "warning":
      return THEME.warning;
    case "accent":
      return THEME.primary;
    default:
      return THEME.muted;
  }
}

function displayWidth(text: string): number {
  return terminalCellWidth(text);
}

function clip(text: string, width: number): string {
  return clipTerminalCells(text, width);
}

/** Collapse whitespace to single spaces, keeping the no-break spaces that pad columns. */
function oneLine(text: string): string {
  return text.replace(/[^\S\u00a0]+/g, " ").replace(/^ +| +$/g, "");
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

export interface QuestionProps {
  readonly model: QuestionModel;
  readonly viewport: Viewport;
}

/** The card's size, placement, and visible choices; `height` is what the layout reserves. */
export function questionLayout(source: QuestionModel, viewport: Viewport) {
  const model = { ...source, choices: alignDescriptionColumns(source.choices) };
  const frame = overlayWidth(viewport);
  const { fullscreen, width } = frame;
  const inner = Math.max(8, width - BAND_CHROME_COLUMNS);

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

  // A choice preview takes a pane of its own to the right of the list, so the
  // list's own column math runs against a narrower width — never the full card.
  const previewCandidateWidth = Math.floor(inner * PREVIEW_SHARE);
  const hasPreview =
    model.choices.some((choice) => choice.preview !== undefined) &&
    previewCandidateWidth >= PREVIEW_MIN_WIDTH &&
    inner - previewCandidateWidth - PREVIEW_GAP >= PREVIEW_MIN_WIDTH;
  const previewWidth = hasPreview ? previewCandidateWidth : 0;
  const bodyInner = hasPreview ? inner - previewWidth - PREVIEW_GAP : inner;

  // Descriptions align into their own column so the choices read as a table.
  // Labels keep the majority of the row: the label is the answer, the
  // description is only the reason for it.
  const markColumn = GUTTER + NUMBER_COLUMN + (checkbox ? CHECKBOX_COLUMN : 0);
  // Tags take a column of their own on the right, as wide as the widest tag, so they line up.
  const widestTag = model.choices.reduce(
    (widest, choice) => Math.max(widest, displayWidth(choice.tag ?? "")),
    0,
  );
  const tagColumn = widestTag > 0 ? Math.min(widestTag, Math.floor(bodyInner / 3)) : 0;
  const bodyWidth = Math.max(
    4,
    bodyInner - markColumn - (tagColumn > 0 ? tagColumn + DESCRIPTION_GAP : 0),
  );
  const described =
    !hasPreview && model.choices.some((choice) => (choice.description ?? "").length > 0);
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
  // The stepper row and the blank that separates it from the question.
  const stepRows = model.step === undefined ? 0 : 2;
  const fixedRows = FIXED_CARD_ROWS + message.length + filterRows + stepRows;
  if (model.buttons === true) {
    const buttonRows = custom ? 3 : 1;
    const placed = placeOverlay(viewport, frame, fixedRows + buttonRows + HINT_ROWS);
    return {
      fullscreen,
      width,
      inner,
      filterable,
      checkbox,
      checked,
      message,
      total,
      selected,
      labelWidth: 0,
      descriptionWidth: 0,
      tagColumn: 0,
      items,
      layouts,
      heights,
      listRows: buttonRows,
      visible: items,
      start: 0,
      listOffset: 0,
      hasPreview: false,
      previewWidth: 0,
      selectedPreview: undefined,
      height: placed.height,
      cardHeight: Math.max(1, placed.height - HINT_ROWS),
      left: placed.left,
      top: placed.top,
    };
  }
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
  // A tag column is flush right, so a list that carries tags spans the card instead of centering.
  // A preview pane pins the list to the left edge of its own column too — there is nothing to
  // center against once the row reads as two panes rather than one floating block.
  const listOffset =
    hasPreview || filterable || tagColumn > 0 || widestOptionRow >= bodyInner
      ? 0
      : centeredOffset(widestOptionRow, bodyInner);

  const { height, left, top } = placeOverlay(viewport, frame, fixedRows + listRows + HINT_ROWS);
  const cardHeight = Math.max(1, height - HINT_ROWS);
  const selectedChoice = items[selected] ?? null;
  const selectedPreview = selectedChoice?.preview;
  return {
    fullscreen,
    width,
    inner,
    filterable,
    checkbox,
    checked,
    message,
    total,
    selected,
    labelWidth,
    descriptionWidth,
    tagColumn,
    items,
    layouts,
    heights,
    listRows,
    visible,
    start,
    listOffset,
    hasPreview,
    previewWidth,
    selectedPreview,
    height,
    cardHeight,
    left,
    top,
  };
}

/** The highlighted choice's preview, wrapping each line rather than clipping it. */
function PreviewPane({
  lines,
  width,
}: {
  readonly lines: readonly ChoicePreviewLine[];
  readonly width: number;
}): ReactNode {
  return (
    <>
      {lines.flatMap((line, lineIndex) => {
        // A caption is almost always one plain span; word-wrap it across rows rather than
        // clipping it, so "no color; every line reads the same" is not "no color; every ...".
        // A swatch or other multi-span line keeps its styling on one row instead — wrapping a
        // run of separately-colored spans would need to split a span mid-run, which is not
        // worth it for the short, single-row content every current preview actually uses.
        const onlySpan = line.length === 1 ? line[0] : undefined;
        const rows =
          onlySpan === undefined
            ? [line]
            : wrapLines(onlySpan.text, width).map((piece) => [{ ...onlySpan, text: piece }]);
        return rows.map((row, rowIndex) => (
          <text
            key={`${String(lineIndex)}-${String(rowIndex)}`}
            style={{ height: 1, flexShrink: 0, wrapMode: "none", truncate: true }}
          >
            {row.map((span, spanIndex) => {
              const content = clip(span.text, width);
              const style = { fg: span.fg ?? THEME.secondary };
              return span.bold === true ? (
                <b
                  key={String(spanIndex)}
                  style={style}
                >
                  {content}
                </b>
              ) : (
                <span
                  key={String(spanIndex)}
                  style={style}
                >
                  {content}
                </span>
              );
            })}
          </text>
        ));
      })}
    </>
  );
}

export function Question({ model, viewport }: QuestionProps): ReactNode {
  const glyphs = getGlyphs();
  const {
    width,
    inner,
    filterable,
    checkbox,
    checked,
    message,
    total,
    selected,
    labelWidth,
    descriptionWidth,
    tagColumn,
    items,
    layouts,
    heights,
    listRows,
    visible,
    start,
    listOffset,
    hasPreview,
    previewWidth,
    selectedPreview,
    height,
    cardHeight,
    left,
    top,
  } = questionLayout(model, viewport);
  const stepper =
    model.step === undefined
      ? null
      : stepperSegments(model.step, Math.max(4, inner - GUTTER), glyphs.success);

  // The key legend and its wording come from the shared question model, so the Ink
  // questionnaire lists the same keys in the same words.
  const expendable = new Map([
    ["esc", 0],
    ["enter", 1],
    ["y/n", 2],
    ["space", 2],
    ["type", 2],
  ]);
  const keys = filterable
    ? [
        { key: "up/down", label: "choose" },
        { key: "type", label: "filter" },
        { key: "enter", label: "select" },
        { key: "esc", label: model.skippable === true ? "skip question" : "cancel" },
      ]
    : questionKeys({
        binary: model.buttons === true,
        multiple: checkbox,
        choiceCount: model.choices.length,
        skippable: model.skippable === true,
      });
  const hints: readonly Hint[] = keys.map((entry) => ({
    ...entry,
    expendable: expendable.get(entry.key) ?? 3,
  }));

  const tally = checkbox
    ? `${String(checked.size)} selected`
    : total === 0
      ? filterable
        ? "no matches"
        : undefined
      : model.buttons !== true && total > visible.length
        ? `${String(selected + 1)} of ${String(total)}`
        : undefined;
  const positionLabel = questionPositionLabel(model.position);
  const messageBudget = Math.max(
    4,
    inner - GUTTER - (positionLabel === undefined ? 0 : displayWidth(positionLabel) + GUTTER),
  );

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
          ...bandStyle(glyphs, THEME.surface, THEME.primary),
          paddingTop: 1,
          paddingBottom: 1,
        }}
      >
        {stepper === null ? null : (
          <>
            <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
              <text style={{ width: GUTTER, flexShrink: 0 }}>{" ".repeat(GUTTER)}</text>
              <text style={{ wrapMode: "none", truncate: true }}>
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
            </box>
            <box style={{ height: 1, flexShrink: 0 }} />
          </>
        )}
        {message.map((line, index) => (
          <box
            key={`message-${String(index)}`}
            style={{ height: 1, flexShrink: 0, flexDirection: "row" }}
          >
            <text style={{ fg: THEME.muted, width: GUTTER, flexShrink: 0 }}>
              {index === 0 ? `${glyphs.question} ` : " ".repeat(GUTTER)}
            </text>
            <text style={{ wrapMode: "none" }}>
              <b style={{ fg: THEME.selected }}>{clip(line, messageBudget)}</b>
            </text>
            {index === 0 && positionLabel !== undefined ? (
              <>
                <box style={{ flexGrow: 1 }} />
                <text style={{ fg: THEME.muted, flexShrink: 0 }}>{positionLabel}</text>
              </>
            ) : null}
          </box>
        ))}

        {filterable ? (
          <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
            <text style={{ fg: THEME.primary, width: GUTTER, flexShrink: 0 }}>
              {`${glyphs.promptCursor} `}
            </text>
            <CaretValue
              value={oneLine(model.filter ?? "")}
              caret={model.filterCaret ?? displayWidth(model.filter ?? "")}
              width={Math.max(4, inner - GUTTER)}
              placeholder={FILTER_PLACEHOLDER}
            />
          </box>
        ) : null}

        <box style={{ height: 1, flexShrink: 0 }} />

        <box style={{ height: listRows, flexShrink: 0, flexDirection: "row" }}>
          <box
            style={{
              height: listRows,
              flexShrink: 0,
              flexDirection: "column",
              paddingLeft: listOffset,
            }}
          >
            {model.buttons === true ? (
              <>
                <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
                  <text style={{ width: GUTTER, flexShrink: 0 }}>{" ".repeat(GUTTER)}</text>
                  <text style={{ wrapMode: "none" }}>
                    {model.choices.flatMap((choice, index) => {
                      const filled = index === selected;
                      const label = `${" ".repeat(BUTTON_PAD)}${oneLine(choice.label)}${" ".repeat(BUTTON_PAD)}`;
                      return [
                        ...(index > 0
                          ? [<span key={`gap-${String(index)}`}>{" ".repeat(BUTTON_GAP)}</span>]
                          : []),
                        filled ? (
                          <b
                            key={choice.value}
                            style={{ fg: onAccent(THEME.primary), bg: THEME.primary }}
                          >
                            {label}
                          </b>
                        ) : (
                          <span
                            key={choice.value}
                            style={{ fg: THEME.secondary, bg: THEME.surfaceStrong }}
                          >
                            {label}
                          </span>
                        ),
                      ];
                    })}
                  </text>
                </box>
                {items.length > model.choices.length ? (
                  <>
                    <box style={{ height: 1, flexShrink: 0 }} />
                    <box
                      style={{
                        height: 1,
                        flexShrink: 0,
                        flexDirection: "row",
                        ...(selected === model.choices.length
                          ? { backgroundColor: THEME.surfaceStrong }
                          : {}),
                      }}
                    >
                      <text style={{ fg: THEME.primary, width: GUTTER, flexShrink: 0 }}>
                        {selected === model.choices.length
                          ? `${glyphs.arrow} `
                          : " ".repeat(GUTTER)}
                      </text>
                      {selected === model.choices.length ? (
                        <CaretValue
                          value={model.customValue ?? ""}
                          caret={model.customCaret ?? displayWidth(model.customValue ?? "")}
                          width={Math.max(4, inner - GUTTER)}
                          placeholder={CUSTOM_HINT}
                        />
                      ) : (
                        <text style={{ fg: THEME.muted, attributes: TextAttributes.ITALIC }}>
                          {CUSTOM_HINT}
                        </text>
                      )}
                    </box>
                  </>
                ) : null}
              </>
            ) : filterable && items.length === 0 ? (
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
                      style={{
                        height: 1,
                        flexShrink: 0,
                        flexDirection: "row",
                        ...(isSelected ? { backgroundColor: THEME.surfaceStrong } : {}),
                      }}
                    >
                      <text style={{ fg: THEME.primary, width: GUTTER, flexShrink: 0 }}>
                        {isSelected ? `${glyphs.arrow} ` : " ".repeat(GUTTER)}
                      </text>
                      <text style={{ fg: THEME.muted, width: NUMBER_COLUMN, flexShrink: 0 }}>
                        {windowChoiceNumber(offset)}
                      </text>
                      {isSelected ? (
                        <CaretValue
                          value={model.customValue ?? ""}
                          caret={model.customCaret ?? displayWidth(model.customValue ?? "")}
                          width={Math.max(4, inner - GUTTER - NUMBER_COLUMN)}
                          placeholder={CUSTOM_HINT}
                        />
                      ) : (
                        <text
                          style={{
                            fg: THEME.muted,
                            attributes: TextAttributes.ITALIC,
                            flexShrink: 0,
                          }}
                        >
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
                    style={{
                      height: shownRows,
                      flexShrink: 0,
                      flexDirection: "column",
                      ...(isSelected ? { backgroundColor: THEME.surfaceStrong } : {}),
                    }}
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
                            {isSelected && row === 0 ? `${glyphs.arrow} ` : " ".repeat(GUTTER)}
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
                            <text
                              style={{
                                fg: THEME.muted,
                                width: descriptionWidth + DESCRIPTION_GAP,
                                flexShrink: 0,
                              }}
                            >
                              {`${" ".repeat(DESCRIPTION_GAP)}${description}`}
                            </text>
                          ) : null}
                          {tagColumn > 0 ? (
                            <text
                              style={{
                                fg: tagColor(choice.tagTone),
                                width: tagColumn + DESCRIPTION_GAP,
                                flexShrink: 0,
                              }}
                            >
                              {row === 0 && (choice.tag ?? "").length > 0
                                ? `${" ".repeat(DESCRIPTION_GAP + Math.max(0, tagColumn - displayWidth(clip(choice.tag ?? "", tagColumn))))}${clip(choice.tag ?? "", tagColumn)}`
                                : ""}
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
          {hasPreview ? (
            <box
              style={{
                height: listRows,
                width: previewWidth,
                flexShrink: 0,
                flexDirection: "column",
                paddingLeft: PREVIEW_GAP,
              }}
            >
              {selectedPreview === undefined ? null : (
                <PreviewPane
                  lines={selectedPreview}
                  width={previewWidth}
                />
              )}
            </box>
          ) : null}
        </box>

        <box style={{ height: 1, flexShrink: 0 }} />
      </box>

      <HintRow
        hints={hints}
        width={width}
        {...(tally === undefined ? {} : { tally })}
      />
    </box>
  );
}
