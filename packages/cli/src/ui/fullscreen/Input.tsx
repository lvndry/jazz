/** @jsxImportSource @opentui/react */

/**
 * The composer: the one region the user's hands are on.
 *
 *   ▏ 4 more lines                                              2 queued
 *   ▏ ∙ move the smaller meeting
 *   ▏ ∙ send the itinerary
 *   » and then check whether anything on Thursday afternoon collides with
 *     the flight, and if it does, move the smaller thing█
 *
 * Anchored to the bottom, above the footer, and it never moves: a quiet row
 * sits above it, the live zone grows upward from there, and the transcript
 * yields the rows, so the caret stays at the same screen position for a whole
 * session. `flexShrink: 0` is what enforces that from this side — the composer
 * is the last region that should give up space.
 *
 * ── Why the buffer is drawn here rather than by `<textarea>` ──────────────
 *
 * OpenTUI ships a real `TextareaRenderable`, and it is a better *editor* than
 * anything drawn by hand: multi-line editing, word motions, selection, undo,
 * paste. It is the wrong fit here for three reasons, in order of weight.
 *
 *   1. It is uncontrolled. `TextareaOptions` takes `initialValue` and then owns
 *      an internal `EditBuffer`. `InputModel.value` is the authority in this
 *      architecture, and two sources of truth for the draft means the things
 *      that must write to the composer — replaying a queued message, expanding
 *      a slash command, restoring a resumed session — have nowhere to write.
 *   2. It eats the keyboard. The shell resolves keys centrally through
 *      `keymap.ts`, so escape-to-interrupt, focus switching and the overlay's
 *      claim on input all pass through one place. A focused textarea consumes
 *      keys before that resolution and would have to be fought, not composed
 *      with.
 *   3. A frame would stop being reproducible from data. Every other region
 *      here is a pure function of the view model, which is what lets the layout
 *      be asserted character by character instead of eyeballed.
 *
 * The trade is real and named: cursor motion, selection and undo live on
 * `InputModel` (caret, anchor) and the composer history in the bridge. This
 * region paints both without changing shape.
 */

import { TextAttributes } from "@opentui/core";
import { memo, type ReactNode } from "react";
import { isShellEscape } from "@/cli/chat/commands/parser";
import { getGlyphs, type GlyphSet } from "../glyphs";
import { matchedSpan, plainDescription, suggestionOrigin } from "../suggestion-menu";
import { useThemeRevision } from "./theme-revision";
import { COMPACT_HEIGHT, type InputModel, type Viewport } from "./types";
import { pickerWindow, wrapIndex } from "../text/picker-window";
import {
  clipTerminalCells,
  fitTerminalSegments,
  terminalCellWidth,
  terminalGraphemes,
  terminalSegmentsWidth,
  wrapTerminalCells,
} from "../text/terminal-cells";
import { THEME } from "../theme";

/**
 * The composer grows to six rows and then scrolls inside itself. Past six rows
 * a message is a document, and a document that pushes the conversation off the
 * screen while it is being written is worse than one that scrolls.
 */
export const INPUT_MAX_ROWS = 6;

/** Same cap as the Ink dropdown: a 20-row list is unscannable. */
const MAX_VISIBLE_COMMANDS = 8;

/** The selection rail and its space. */
const COMMAND_MARKER_CELLS = 2;

/** Name, tag and description columns sit this far apart. */
const COMMAND_COLUMN_GAP = 2;

/** Past this a name column stops widening and long names clip, so descriptions stay visible. */
const MAX_COMMAND_LABEL_CELLS = 28;

/**
 * Newest queued entries shown under the count. Older ones remain in the
 * count, so a long queue cannot push the composer off the screen.
 */
export const MAX_VISIBLE_QUEUED = 3;

export function wrapCommandIndex(index: number, length: number): number {
  return wrapIndex(index, length);
}

/** The band's bar and its space on the left, one cell of padding on the right. */
const GUTTER_CELLS = 3;

/** Cells kept between the draft's first line and the model on the right. */
const META_GAP = 2;

/** Top and bottom padding rows of the composer's band. */
const BAND_PADDING_ROWS = 2;

export interface InputSegment {
  readonly text: string;
  readonly fg: string;
  readonly bg?: string;
  readonly bold?: boolean;
}

export interface InputRow {
  readonly key: string;
  readonly segments: readonly InputSegment[];
  /** The band ground the whole row is painted with, trailing cells included. */
  readonly surface?: string;
}

// Per-paragraph wrap; see `wrapTerminalCells` for the wrap itself.
export function wrapCells(value: string, columns: number): string[] {
  const width = Math.max(1, columns);
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    lines.push(...wrapTerminalCells(paragraph, width));
  }
  return lines;
}

/**
 * A row laid on a band: every cell takes the band's ground unless it already
 * has its own (the caret, a selection), and the row is filled to the full width
 * so the band reads as one surface rather than as highlighted text.
 */
function onBand(row: InputRow, surface: string, width: number): InputRow {
  const fitted = fitTerminalSegments(row.segments, width);
  const gap = Math.max(0, width - terminalSegmentsWidth(fitted));
  const segments: InputSegment[] = fitted.map((segment) =>
    segment.bg === undefined ? { ...segment, bg: surface } : segment,
  );
  if (gap > 0) segments.push({ text: " ".repeat(gap), fg: THEME.muted, bg: surface });
  return { key: row.key, segments, surface };
}

function alignRow(
  key: string,
  left: readonly InputSegment[],
  right: readonly InputSegment[],
  width: number,
): InputRow {
  const rightWidth = terminalSegmentsWidth(right);
  if (rightWidth + 1 > width) return { key, segments: [] };
  const budget = width - rightWidth - 1;
  const kept = fitTerminalSegments(left, budget);
  const gap = Math.max(0, width - terminalSegmentsWidth(kept) - rightWidth);
  const padding: InputSegment[] = gap > 0 ? [{ text: " ".repeat(gap), fg: THEME.muted }] : [];
  return { key, segments: [...kept, ...padding, ...right] };
}

/**
 * The caret is a painted cell rather than the terminal's own cursor: the frame
 * is composited, so the one thing the reader looks for has to be part of it.
 */
/** The rows of the slash and `@` menu, shared by the chat composer and home. */
export function commandSuggestRows(
  commands: NonNullable<InputModel["commands"]>,
  width: number,
  glyphs: GlyphSet,
  size: number = MAX_VISIBLE_COMMANDS,
): InputRow[] {
  if (size <= 0) return [];
  const visible = pickerWindow(commands.items, commands.selected, size);
  const prefix = commands.prefix ?? "/";
  const label = (command: (typeof visible)[number]): string =>
    `${prefix}${command.name}${command.usage === undefined ? "" : ` ${command.usage}`}`;
  // Columns are sized over the window rather than the whole list, so one long
  // skill name far down the list does not push every visible description right.
  const labelColumn = Math.min(
    MAX_COMMAND_LABEL_CELLS,
    Math.max(0, ...visible.map((command) => terminalCellWidth(label(command)))),
  );
  // A path list is all files, so a tag on every row would be noise; only the
  // mixed command list says where an entry came from — and a file entry's
  // `source` is always undefined, so the column falls out naturally.
  const tagColumn = Math.max(
    0,
    ...visible.map((command) => terminalCellWidth(suggestionOrigin(command.source) ?? "")),
  );
  const rows: InputRow[] = visible.map((command) => {
    const selected = command === commands.items[commands.selected];
    const name = clipTerminalCells(label(command), labelColumn);
    const origin = suggestionOrigin(command.source) ?? "";
    const lead = COMMAND_MARKER_CELLS + labelColumn + COMMAND_COLUMN_GAP;
    const tagCells = tagColumn === 0 ? 0 : tagColumn + COMMAND_COLUMN_GAP;
    const descriptionBudget = Math.max(0, width - lead - tagCells);
    const description = clipTerminalCells(plainDescription(command.description), descriptionBudget);
    const nameColor = selected ? THEME.selected : THEME.secondary;
    // The query's letters are bold where the name contains them; the sigil shifts the span.
    const span = matchedSpan(command.name, commands.query ?? "");
    const at: readonly [number, number] | undefined =
      span === undefined ? undefined : [span[0] + prefix.length, span[1] + prefix.length];
    const padding = " ".repeat(Math.max(0, labelColumn - terminalCellWidth(name)));
    const nameSegments: InputSegment[] =
      at === undefined || at[1] > [...name].length
        ? [{ text: name + padding, fg: nameColor }]
        : [
            { text: name.slice(0, at[0]), fg: nameColor },
            { text: name.slice(at[0], at[1]), fg: THEME.selected, bold: true },
            { text: name.slice(at[1]) + padding, fg: nameColor },
          ];
    const segments: InputSegment[] = [
      { text: selected ? `${glyphs.bandBar} ` : "  ", fg: THEME.primary },
      ...nameSegments,
      { text: " ".repeat(COMMAND_COLUMN_GAP), fg: THEME.muted },
      ...(tagColumn === 0
        ? []
        : [
            {
              text: `${origin.padEnd(tagColumn)}${" ".repeat(COMMAND_COLUMN_GAP)}`,
              fg: THEME.muted,
            },
          ]),
      { text: description, fg: selected ? THEME.secondary : THEME.muted },
    ];
    return { key: `${prefix}${command.name}`, segments: fitTerminalSegments(segments, width) };
  });
  return rows;
}

function previewQueuedEntry(entry: string): string {
  return entry.replace(/\s+/g, " ").trim();
}

/** Cells before the queue rows, so the chip lines up with the composer's text. */
const QUEUE_INDENT = "  ";

/**
 * What is waiting for the next turn, above the composer rather than inside it: a chip
 * with the count, in the accent on the element plane, and the key that pulls it all
 * back to edit. It sits on the canvas because it is not something being typed.
 */
function queueChipRow(count: number, width: number): InputRow {
  return alignRow(
    "queue:chip",
    [
      { text: QUEUE_INDENT, fg: THEME.muted },
      {
        text: ` ${String(count)} queued `,
        fg: THEME.primary,
        bg: THEME.surfaceStrong,
        bold: true,
      },
    ],
    [
      { text: "up", fg: THEME.secondary, bold: true },
      { text: " edit ", fg: THEME.muted },
    ],
    width,
  );
}

function queuePreviewRows(entries: readonly string[], width: number, glyphs: GlyphSet): InputRow[] {
  return entries.map((entry, index) => {
    const oneLine = previewQueuedEntry(entry);
    const segments: InputSegment[] = [
      { text: `${QUEUE_INDENT} ${glyphs.bullet} `, fg: THEME.muted },
      { text: oneLine, fg: THEME.secondary },
    ];
    return {
      key: `queue:${String(index)}:${oneLine}`,
      segments: fitTerminalSegments(segments, width),
    };
  });
}

function caret(character: string): InputSegment {
  return { text: character, fg: THEME.canvas, bg: THEME.prompt };
}

function selected(character: string, fg: string): InputSegment {
  return { text: character, fg, bg: THEME.muted };
}

function pushSegment(segments: InputSegment[], segment: InputSegment): void {
  const last = segments[segments.length - 1];
  if (last !== undefined && last.fg === segment.fg && last.bg === segment.bg) {
    segments[segments.length - 1] = { ...last, text: last.text + segment.text };
    return;
  }
  segments.push(segment);
}

function wrapCellsWithOffsets(
  value: string,
  columns: number,
): readonly { readonly text: string; readonly start: number }[] {
  const width = Math.max(1, columns);
  const lines: { text: string; start: number }[] = [];
  let offset = 0;
  const paragraphs = value.split("\n");
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const wrapped = wrapTerminalCells(paragraph, width);
    let local = 0;
    for (const text of wrapped) {
      lines.push({ text, start: offset + local });
      local += [...text].length;
    }
    offset += [...paragraph].length;
    if (paragraphIndex < paragraphs.length - 1) offset += 1;
  });
  return lines;
}

export interface InputProps {
  readonly model: InputModel;
  readonly viewport: Viewport;
  /**
   * Whether the keyboard is aimed here. Defaults to "yes unless something else
   * took it", which is what `disabled` means, so the shell can leave it off
   * until it has a reason to say otherwise.
   */
  readonly focused?: boolean;
  /** Rows the shell can spare; see `inputRows`. */
  readonly maxRows?: number;
  /**
   * A docked card sits over the composer. The rows keep their height so nothing
   * moves when the card closes, but draw nothing, so no fragment of the draft
   * shows beside the card's own controls.
   */
  readonly concealed?: boolean;
}

/**
 * The rows the composer would draw, top to bottom. Pure, and exported, because
 * the region's contract is arithmetic: it never exceeds `INPUT_MAX_ROWS`, never
 * exceeds the width, and shows a caret exactly when the keyboard is live.
 */
export function inputRows(
  model: InputModel,
  viewport: Viewport,
  focused = !model.disabled,
  glyphs: GlyphSet = getGlyphs(),
  /**
   * Rows the shell can spare. Without it the composer plus an open command list
   * can want more rows than the terminal has, and at the compact 32x10
   * minimum the overflow pushes the footer off the bottom of the screen. The
   * default is the unconstrained demand, so standalone callers see the natural
   * size.
   */
  maxRows: number = INPUT_MAX_ROWS + MAX_VISIBLE_COMMANDS + MAX_VISIBLE_QUEUED,
): readonly InputRow[] {
  const width = Math.max(1, viewport.width);
  const contentWidth = Math.max(1, width - GUTTER_CELLS);
  const live = focused && !model.disabled;
  // A shell escape hands the line to the shell instead of the model. The rail
  // and marker pick up the warning hue so that is visible before Enter is hit.
  const shellCommand = live && isShellEscape(model.value);
  const empty = model.value.length === 0;
  const valueCodePoints = [...model.value].length;
  const caretAt = Math.max(0, Math.min(model.caret ?? valueCodePoints, valueCodePoints));
  const anchorAt = Math.max(0, Math.min(model.anchor ?? caretAt, valueCodePoints));
  const selStart = Math.min(caretAt, anchorAt);
  const selEnd = Math.max(caretAt, anchorAt);

  // An empty composer shows the placeholder in the text's place; a disabled one
  // keeps whatever was already typed, because losing sight of a draft to a
  // modal is worse than losing the caret.
  const wrapped = empty
    ? [{ text: clipTerminalCells(model.placeholder, contentWidth), start: 0 }]
    : [...wrapCellsWithOffsets(model.value, contentWidth)];
  if (
    !empty &&
    live &&
    terminalCellWidth(wrapped[wrapped.length - 1]?.text ?? "") >= contentWidth
  ) {
    wrapped.push({ text: "", start: valueCodePoints });
  }
  const lines = wrapped.map((line) => line.text);

  // Reuse `wrapped` rather than re-wrapping the text before the caret — a
  // prefix alone can't know a word will later get carried to the next line.
  let caretLine = 0;
  for (let index = 0; index < wrapped.length; index += 1) {
    const entry = wrapped[index];
    if (entry === undefined || entry.start > caretAt) break;
    caretLine = index;
  }
  const caretLineEntry = wrapped[caretLine];
  const caretColumn =
    caretLineEntry === undefined
      ? 0
      : terminalCellWidth(
          [...caretLineEntry.text].slice(0, caretAt - caretLineEntry.start).join(""),
        );

  const queued = model.queued;
  const queuedCount = queued.length;
  const budget = Math.max(1, Math.trunc(maxRows));
  const commandItems = model.commands?.items.length ?? 0;
  const wantsCommands = model.commands !== undefined && commandItems > 0;
  const commandReserve = wantsCommands ? 1 : 0;
  // Previews yield before the composer or an open command list. The count row
  // is reserved separately so a squeezed frame can still say how many wait.
  const queueChrome = queuedCount > 0 ? 1 : 0;
  const previewRoom = Math.max(0, budget - 1 - commandReserve - queueChrome);
  const previewCount = Math.min(queuedCount, MAX_VISIBLE_QUEUED, previewRoom);
  const visibleQueued = previewCount === 0 ? [] : queued.slice(-previewCount);
  // The text always keeps at least one row, and the list keeps at least one
  // whenever it is open — whichever of them has to shrink, neither vanishes.
  const textBudget = Math.max(1, Math.min(INPUT_MAX_ROWS, budget - commandReserve - previewCount));
  // The queue's count row sits above the band, so it comes out of the text's
  // budget too; the marker that says "there is more above" then shares what is left.
  const textRows = Math.max(1, textBudget - queueChrome);
  const capWithChrome = Math.max(1, textRows - 1);
  let visible = wrapped;
  let hidden = 0;
  if (lines.length > textRows) {
    const cap = capWithChrome;
    hidden = Math.max(0, Math.min(caretLine - (cap - 1), lines.length - cap));
    visible = wrapped.slice(hidden, hidden + cap);
  }

  const barFg = shellCommand ? THEME.warning : live ? THEME.primary : THEME.border;
  const queueRows: InputRow[] =
    queuedCount > 0
      ? [queueChipRow(queuedCount, width), ...queuePreviewRows(visibleQueued, width, glyphs)]
      : [];
  const rows: InputRow[] = [];
  if (hidden > 0) {
    rows.push({
      key: "chrome",
      segments: fitTerminalSegments(
        [
          { text: `${glyphs.bandBar} `, fg: THEME.border },
          {
            text: `${glyphs.railDeep} ${hidden} more line${hidden === 1 ? "" : "s"}`,
            fg: THEME.muted,
          },
        ],
        width,
      ),
    });
  }

  // The caret's own line may have scrolled out of `visible` — the window
  // always shows the *last* capWithChrome lines, so a caret placed earlier in
  // a long multi-line draft can be above it. Clamping it to the top of what is
  // shown keeps a caret visible always, rather than rendering none at all.
  const visibleCaretLine = Math.max(0, caretLine - hidden);

  visible.forEach((line, index) => {
    // The bar is the composer's state: the accent while it takes keys, the
    // warning hue while the line is a shell escape, the border tone otherwise.
    const bar: InputSegment = {
      text: `${glyphs.bandBar} `,
      fg: barFg,
    };

    const body: InputSegment[] = [];
    const onCaretLine = live && index === visibleCaretLine;
    const fg = model.disabled ? THEME.muted : THEME.selected;
    if (empty) {
      // The caret owns its cell and the placeholder starts one cell later, so the hint is read
      // whole instead of losing its first letter under the caret.
      if (live) {
        body.push(caret(" "), { text: line.text, fg: THEME.muted });
      } else {
        body.push({ text: line.text, fg: THEME.muted });
      }
    } else {
      const graphemes = terminalGraphemes(line.text);
      let caretIndex = graphemes.length;
      if (onCaretLine) {
        let usedCells = 0;
        caretIndex = 0;
        while (
          caretIndex < graphemes.length &&
          usedCells + terminalCellWidth(graphemes[caretIndex] as string) <= caretColumn
        ) {
          usedCells += terminalCellWidth(graphemes[caretIndex] as string);
          caretIndex += 1;
        }
      }
      let codePoint = line.start;
      graphemes.forEach((grapheme, column) => {
        const highlighted = codePoint >= selStart && codePoint < selEnd;
        if (onCaretLine && column === caretIndex) pushSegment(body, caret(grapheme));
        else if (highlighted) pushSegment(body, selected(grapheme, fg));
        else pushSegment(body, { text: grapheme, fg });
        codePoint += [...grapheme].length;
      });
      if (onCaretLine && caretIndex >= graphemes.length) {
        body.push(caret(" "));
      }
    }

    const meta = index === 0 && model.meta !== undefined ? model.meta : "";
    const room = contentWidth - terminalSegmentsWidth(body) - META_GAP;
    const right: InputSegment[] =
      meta.length > 0 && terminalCellWidth(meta) <= room
        ? [
            { text: meta, fg: THEME.muted },
            { text: " ", fg: THEME.muted },
          ]
        : [];
    rows.push(
      right.length === 0
        ? { key: `line:${String(index)}`, segments: [bar, ...body] }
        : alignRow(`line:${String(index)}`, [bar, ...body], right, width),
    );
  });

  // Padding rows are the first thing a short terminal gives back: they are
  // drawn only when the text, the queue and one row of any open list all fit.
  const padded =
    viewport.height >= COMPACT_HEIGHT &&
    queueRows.length + rows.length + BAND_PADDING_ROWS + commandReserve <= budget;
  const padRow = (key: string): InputRow => ({
    key,
    segments: [{ text: `${glyphs.bandBar} `, fg: barFg }],
  });
  const composer = [
    ...queueRows,
    ...(padded ? [padRow("pad:top"), ...rows, padRow("pad:bottom")] : rows).map((row) =>
      onBand(row, THEME.surfaceStrong, width),
    ),
  ];

  // The list is laid on top last so it can be sized against what the text
  // actually took, then it goes above the composer where it belongs.
  if (!wantsCommands || model.commands === undefined) return composer;
  const listSize = Math.min(MAX_VISIBLE_COMMANDS, Math.max(0, budget - composer.length));
  const list = commandSuggestRows(model.commands, width, glyphs, listSize).map((row) =>
    onBand(row, THEME.surface, width),
  );
  return [...list, ...composer];
}

function InputView({ model, viewport, focused, maxRows, concealed }: InputProps): ReactNode {
  useThemeRevision();
  const rows = inputRows(model, viewport, focused ?? !model.disabled, undefined, maxRows);

  return (
    <box
      style={{
        width: viewport.width,
        height: rows.length,
        flexShrink: 0,
        flexDirection: "column",
      }}
    >
      {rows.map((row) => (
        <box
          key={row.key}
          style={{
            width: viewport.width,
            height: 1,
            flexShrink: 0,
            ...(row.surface === undefined || concealed === true
              ? {}
              : { backgroundColor: row.surface }),
          }}
        >
          <text style={{ wrapMode: "none" }}>
            {(concealed === true ? [] : row.segments).map((segment, index) => (
              <span
                key={`${String(index)}:${segment.text}`}
                style={{
                  fg: segment.fg,
                  ...(segment.bg === undefined ? {} : { bg: segment.bg }),
                  ...(segment.bold === true ? { attributes: TextAttributes.BOLD } : {}),
                }}
              >
                {segment.text}
              </span>
            ))}
          </text>
        </box>
      ))}
    </box>
  );
}

export const Input = memo(InputView);
