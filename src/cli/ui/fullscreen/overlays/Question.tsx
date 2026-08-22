/** @jsxImportSource @opentui/react */

/**
 * The question overlay — `select`, `confirm`, `checkbox` and `questionnaire`.
 *
 * This is the most common interactive object in the product: the agent has to
 * ask something before it can continue, and until it is answered nothing else
 * happens. So it is built to be answered without reading it twice.
 *
 *   - One row per choice. The label and its description share that row, with
 *     the descriptions aligned into a column so the set reads as a table
 *     rather than as a paragraph per option. Nothing wraps and nothing is
 *     hidden behind the selection: every description is on screen at once.
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
import { THEME } from "../../theme";
import type { Viewport } from "../types";
import { CaretValue, HintRow, type Hint } from "./TextPrompt";

/** Windowed width, and the floor below which windowing stops making sense. */
const MAX_WIDTH = 76;
const MIN_WINDOWED_HEIGHT = 20;

/** One column of breathing room inside the frame, on each side. */
const CARD_PAD = 1;

/** Border, blank above the list, blank below it. */
const FIXED_CARD_ROWS = 4;

/** The keys line, beneath the frame. */
const HINT_ROWS = 1;

/** Rail, space. The gutter every row shares. */
const GUTTER = 2;

/** `1 ` — a quick-pick number, or two spaces past the ninth choice. */
const NUMBER_COLUMN = 2;

/** `[x] ` — the checkbox mark and the space after it. */
const CHECKBOX_COLUMN = 4;

/** Quick-pick covers the digit keys, so only the first nine are numbered. */
const QUICK_PICK_LIMIT = 9;

/** Descriptions never take more of the row than the labels they annotate. */
const DESCRIPTION_SHARE = 0.45;

/** Two spaces between a label and its description, so the column reads as one. */
const DESCRIPTION_GAP = 2;

/** A long question is worth two rows; past that it is not a question. */
const MESSAGE_MAX_ROWS = 3;

/** Keep this much context past the selection before the list starts to follow it. */
const LIST_MARGIN = 1;

/** The custom row says what it is for, in the house voice, rather than "Other". */
const CUSTOM_HINT = "Type your own answer";

const ELLIPSIS = "...";

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
 * Where the visible slice of a long list starts.
 *
 * The component holds no state, so the window cannot "remember" where it was
 * and drift: it is derived. Top-anchored until the selection comes within a
 * row of the bottom edge, then it follows — which keeps the first screenful
 * perfectly still while still guaranteeing the selection is on screen.
 */
function windowStartFor(selected: number, total: number, rows: number): number {
  if (total <= rows) return 0;
  const wanted = selected + 1 + LIST_MARGIN - rows;
  return Math.max(0, Math.min(wanted, total - rows));
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

  // With no choices at all the user would otherwise be stuck looking at a
  // question they cannot answer, so the custom row appears regardless.
  const custom = model.allowCustom === true || model.choices.length === 0;
  const checkbox = model.mode === "checkbox";
  const checked = new Set(model.checked ?? []);

  const message = wrapProse(model.message, Math.max(4, inner - GUTTER), MESSAGE_MAX_ROWS);
  const total = model.choices.length + (custom ? 1 : 0);
  const selected = Math.max(0, Math.min(model.selected, total - 1));

  const fixedRows = FIXED_CARD_ROWS + message.length;
  const windowedHeight = fixedRows + total + HINT_ROWS;
  const height = fullscreen ? viewport.height : Math.min(windowedHeight, viewport.height);
  const cardHeight = Math.max(1, height - HINT_ROWS);
  const listRows = Math.max(1, cardHeight - fixedRows);
  const start = windowStartFor(selected, total, listRows);

  // The custom row is the last item in one list, not a separate region — so it
  // scrolls with everything else and the arithmetic stays in one place.
  const items: readonly (QuestionChoice | null)[] = custom
    ? [...model.choices, null]
    : model.choices;
  const visible = items.slice(start, start + listRows);

  const left = fullscreen ? 0 : Math.max(0, Math.floor((viewport.width - width) / 2));
  const top = fullscreen ? 0 : Math.max(0, Math.floor((viewport.height - height) / 2));

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

  const hints: readonly Hint[] = checkbox
    ? [
        { key: "up/down", label: "move", expendable: 3 },
        { key: "space", label: "toggle", expendable: 2 },
        { key: "enter", label: "submit", expendable: 1 },
        { key: "esc", label: "cancel", expendable: 0 },
      ]
    : [
        { key: "up/down", label: "move", expendable: 3 },
        { key: "enter", label: "select", expendable: 1 },
        { key: "esc", label: "cancel", expendable: 0 },
      ];

  const tally = checkbox
    ? `${String(checked.size)} selected`
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

        <box style={{ height: 1, flexShrink: 0 }} />

        <box style={{ height: listRows, flexShrink: 0, flexDirection: "column" }}>
          {visible.map((choice, offset) => {
            const index = start + offset;
            const isSelected = index === selected;

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
            const label = clip(oneLine(choice.label), labelWidth);
            const description = clip(oneLine(choice.description ?? ""), descriptionWidth);
            return (
              <box
                key={choice.value}
                style={{ height: 1, flexShrink: 0, flexDirection: "row" }}
              >
                <text style={{ fg: THEME.primary, width: GUTTER, flexShrink: 0 }}>
                  {isSelected ? `${glyphs.rail} ` : " ".repeat(GUTTER)}
                </text>
                <text style={{ fg: THEME.muted, width: NUMBER_COLUMN, flexShrink: 0 }}>
                  {index < QUICK_PICK_LIMIT ? `${String(index + 1)} ` : " ".repeat(NUMBER_COLUMN)}
                </text>
                {checkbox ? (
                  <text style={{ width: CHECKBOX_COLUMN, flexShrink: 0 }}>
                    <span style={{ fg: THEME.muted }}>[</span>
                    <span style={{ fg: isChecked ? THEME.primary : THEME.muted }}>
                      {isChecked ? glyphs.success : " "}
                    </span>
                    <span style={{ fg: THEME.muted }}>{"] "}</span>
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
