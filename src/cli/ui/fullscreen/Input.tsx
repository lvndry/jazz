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

import { memo, type ReactNode } from "react";
import { getGlyphs, type GlyphSet } from "../glyphs";
import { carouselWindow, wrapIndex } from "../picker-window";
import { THEME } from "../theme";
import {
  clipTerminalCells,
  fitTerminalSegments,
  terminalCellWidth,
  terminalGraphemes,
  terminalSegmentsWidth,
  wrapTerminalCells,
} from "./terminal-cells";
import type { InputModel, Viewport } from "./types";

/**
 * The composer grows to six rows and then scrolls inside itself. Past six rows
 * a message is a document, and a document that pushes the conversation off the
 * screen while it is being written is worse than one that scrolls.
 */
export const INPUT_MAX_ROWS = 6;

/** Same cap as the Ink dropdown: a 20-row list is unscannable. */
const MAX_VISIBLE_COMMANDS = 8;

/**
 * Newest queued entries shown under the count. Older ones remain in the
 * count, so a long queue cannot push the composer off the screen.
 */
export const MAX_VISIBLE_QUEUED = 3;

export function wrapCommandIndex(index: number, length: number): number {
  return wrapIndex(index, length);
}

/** Frame rail, prompt marker, and the spaces that keep the text column still. */
const GUTTER_CELLS = 4;

export interface InputSegment {
  readonly text: string;
  readonly fg: string;
  readonly bg?: string;
}

export interface InputRow {
  readonly key: string;
  readonly segments: readonly InputSegment[];
}

/**
 * Character wrapping, not word wrapping.
 *
 * A composer is not prose being typeset — it is a window onto a buffer, and it
 * has to show that buffer exactly. Word wrap eats the space at a break, so a
 * trailing space typed at the wrap boundary would vanish and the caret would
 * appear one cell to the left of where the next character will actually land.
 * Char wrap cannot lie about what has been typed. Explicit newlines are
 * paragraph breaks and survive.
 */
export function wrapCells(value: string, columns: number): string[] {
  const width = Math.max(1, columns);
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    lines.push(...wrapTerminalCells(paragraph, width));
  }
  return lines;
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
function commandSuggestRows(
  commands: NonNullable<InputModel["commands"]>,
  width: number,
  glyphs: GlyphSet,
  size: number = MAX_VISIBLE_COMMANDS,
): InputRow[] {
  if (size <= 0) return [];
  const visible = carouselWindow(commands.items, commands.selected, size);
  const prefix = commands.prefix ?? "/";
  const rows: InputRow[] = visible.map((command) => {
    const selected = command === commands.items[commands.selected];
    const usage = command.usage === undefined ? "" : ` ${command.usage}`;
    // A path list is all files, so a badge on every row would be noise; only
    // the mixed command list needs to say where an entry came from — and a
    // file entry's `source` is always undefined, so it falls out naturally.
    const origin =
      command.source === "skill" ? " (skill)" : command.source === "mcp-prompt" ? " (mcp)" : "";
    const segments: InputSegment[] = [
      { text: selected ? `${glyphs.rail} ` : "  ", fg: THEME.primary },
      { text: `${prefix}${command.name}`, fg: selected ? THEME.selected : THEME.secondary },
      ...(usage.length > 0 ? [{ text: usage, fg: THEME.muted }] : []),
      ...(origin.length > 0 ? [{ text: origin, fg: THEME.muted }] : []),
      { text: `  ${command.description}`, fg: THEME.muted },
    ];
    return { key: `${prefix}${command.name}`, segments: fitTerminalSegments(segments, width) };
  });
  return rows;
}

function previewQueuedEntry(entry: string): string {
  return entry.replace(/\s+/g, " ").trim();
}

function queuePreviewRows(
  entries: readonly string[],
  width: number,
  glyphs: GlyphSet,
  mixedQueue: boolean,
): InputRow[] {
  return entries.map((entry, index) => {
    const oneLine = previewQueuedEntry(entry);
    // Slash commands only run when they are the whole queue; mixed in they
    // go to the model as prose, so say so while the entry is still editable.
    const slashWarning =
      mixedQueue && oneLine.startsWith("/") ? " (sent as text, not run — queue it alone)" : "";
    const segments: InputSegment[] = [
      { text: `${glyphs.rail} `, fg: THEME.border },
      { text: `${glyphs.bullet} `, fg: THEME.muted },
      { text: oneLine, fg: THEME.muted },
      ...(slashWarning.length > 0 ? [{ text: slashWarning, fg: THEME.warning }] : []),
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
  return { text: character, fg, bg: THEME.surfaceStrong };
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
   * can want more rows than the terminal has, and at the documented 60x12
   * minimum the overflow pushes the footer off the bottom of the screen. The
   * default is the unconstrained demand, so standalone callers see the natural
   * size.
   */
  maxRows: number = INPUT_MAX_ROWS + MAX_VISIBLE_COMMANDS + MAX_VISIBLE_QUEUED,
): readonly InputRow[] {
  const width = Math.max(1, viewport.width);
  const contentWidth = Math.max(1, width - GUTTER_CELLS);
  const live = focused && !model.disabled;
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

  const valueBeforeCaret = [...model.value].slice(0, caretAt).join("");
  const linesBeforeCaret = empty ? [""] : wrapCells(valueBeforeCaret, contentWidth);
  let caretLine = Math.max(0, linesBeforeCaret.length - 1);
  let caretColumn = terminalCellWidth(linesBeforeCaret.at(-1) ?? "");
  if (!empty && caretColumn >= contentWidth) {
    caretLine += 1;
    caretColumn = 0;
  }
  caretLine = Math.min(lines.length - 1, caretLine);

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
  // The chrome row and the text rows share one budget, so the marker that says
  // "there is more above" can never itself push the composer past the cap.
  const capWithChrome = Math.max(1, textBudget - 1);
  const capWithoutChrome = queuedCount > 0 ? capWithChrome : textBudget;
  let visible = wrapped;
  let hidden = 0;
  if (lines.length > capWithoutChrome) {
    const cap = capWithChrome;
    hidden = Math.max(0, Math.min(caretLine - (cap - 1), lines.length - cap));
    visible = wrapped.slice(hidden, hidden + cap);
  }

  const rows: InputRow[] = [];
  if (hidden > 0 || queuedCount > 0) {
    const left: InputSegment[] = [
      { text: `${glyphs.rail} `, fg: THEME.border },
      ...(hidden > 0
        ? [
            {
              text: `${glyphs.railDeep} ${hidden} more line${hidden === 1 ? "" : "s"}`,
              fg: THEME.muted,
            },
          ]
        : []),
    ];
    const right: InputSegment[] =
      queuedCount > 0 ? [{ text: `${String(queuedCount)} queued`, fg: THEME.secondary }] : [];
    rows.push(alignRow("chrome", left, right, width));
  }
  if (visibleQueued.length > 0) {
    rows.push(...queuePreviewRows(visibleQueued, width, glyphs, queuedCount > 1));
  }

  // The caret's own line may have scrolled out of `visible` — the window
  // always shows the *last* capWithChrome lines, so a caret placed earlier in
  // a long multi-line draft can be above it. Clamping it to the top of what is
  // shown keeps a caret visible always, rather than rendering none at all.
  const visibleCaretLine = Math.max(0, caretLine - hidden);

  visible.forEach((line, index) => {
    const rail: InputSegment = {
      text: `${glyphs.rail} `,
      fg: live ? THEME.primary : THEME.border,
    };
    const marker: InputSegment =
      index === 0
        ? { text: `${glyphs.promptCursor} `, fg: live ? THEME.prompt : THEME.muted }
        : { text: "  ", fg: THEME.muted };

    const body: InputSegment[] = [];
    const onCaretLine = live && index === visibleCaretLine;
    const fg = model.disabled ? THEME.muted : THEME.selected;
    if (empty) {
      const graphemes = terminalGraphemes(line.text);
      const head = graphemes[0] ?? " ";
      // The caret sits *on* the placeholder's first cell rather than beside it,
      // so an empty composer is one column wide instead of two.
      if (live) body.push(caret(head), { text: graphemes.slice(1).join(""), fg: THEME.muted });
      else body.push({ text: line.text, fg: THEME.muted });
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

    rows.push({ key: `line:${String(index)}`, segments: [rail, marker, ...body] });
  });

  // The list is laid on top last so it can be sized against what the text
  // actually took, then it goes above the composer where it belongs.
  if (!wantsCommands || model.commands === undefined) return rows;
  const listSize = Math.min(MAX_VISIBLE_COMMANDS, Math.max(0, budget - rows.length));
  return [...commandSuggestRows(model.commands, width, glyphs, listSize), ...rows];
}

function InputView({ model, viewport, focused, maxRows }: InputProps): ReactNode {
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
          style={{ width: viewport.width, height: 1, flexShrink: 0 }}
        >
          <text style={{ wrapMode: "none" }}>
            {row.segments.map((segment, index) => (
              <span
                key={`${String(index)}:${segment.text}`}
                style={{
                  fg: segment.fg,
                  ...(segment.bg === undefined ? {} : { bg: segment.bg }),
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
