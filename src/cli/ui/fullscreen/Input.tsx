/** @jsxImportSource @opentui/react */

/**
 * The composer: the one region the user's hands are on.
 *
 *   ▏ 4 more lines                                              2 queued
 *   » and then check whether anything on Thursday afternoon collides with
 *     the flight, and if it does, move the smaller thing█
 *
 * Anchored to the bottom, above the footer, and it never moves: the live zone
 * above it grows upward and the transcript yields the rows, so the caret stays
 * at the same screen position for a whole session. `flexShrink: 0` is what
 * enforces that from this side — the composer is the last region that should
 * give up space.
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
 * The trade is real and named: cursor motion, selection and undo have to live
 * in whatever reducer owns `InputModel`. That is the right home for them
 * anyway — the model has to carry a caret offset eventually, and when it does
 * this region renders it without changing shape.
 */

import type { ReactNode } from "react";
import { getGlyphs, type GlyphSet } from "../glyphs";
import { THEME } from "../theme";
import type { InputModel, Viewport } from "./types";

/**
 * The composer grows to six rows and then scrolls inside itself. Past six rows
 * a message is a document, and a document that pushes the conversation off the
 * screen while it is being written is worse than one that scrolls.
 */
export const INPUT_MAX_ROWS = 6;

/** Prompt marker plus one space. Continuation rows pay the same two columns. */
const GUTTER_CELLS = 2;

const CLIP = "...";

export interface InputSegment {
  readonly text: string;
  readonly fg: string;
  readonly bg?: string;
}

export interface InputRow {
  readonly key: string;
  readonly segments: readonly InputSegment[];
}

function cells(text: string): number {
  return [...text].length;
}

function segmentsWidth(segments: readonly InputSegment[]): number {
  return segments.reduce((total, segment) => total + cells(segment.text), 0);
}

function clip(text: string, max: number): string {
  const characters = [...text];
  if (characters.length <= max) return text;
  if (max <= CLIP.length) return characters.slice(0, Math.max(0, max)).join("");
  return `${characters.slice(0, max - CLIP.length).join("")}${CLIP}`;
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
    const characters = [...paragraph];
    if (characters.length === 0) {
      lines.push("");
      continue;
    }
    for (let start = 0; start < characters.length; start += width) {
      lines.push(characters.slice(start, start + width).join(""));
    }
  }
  return lines;
}

function alignRow(
  key: string,
  left: readonly InputSegment[],
  right: readonly InputSegment[],
  width: number,
): InputRow {
  const rightWidth = segmentsWidth(right);
  if (rightWidth + 1 > width) return { key, segments: [] };
  const budget = width - rightWidth - 1;
  const kept = left.map((segment) => ({ ...segment, text: clip(segment.text, budget) }));
  const gap = Math.max(0, width - segmentsWidth(kept) - rightWidth);
  const padding: InputSegment[] = gap > 0 ? [{ text: " ".repeat(gap), fg: THEME.muted }] : [];
  return { key, segments: [...kept, ...padding, ...right] };
}

/**
 * The caret is a painted cell rather than the terminal's own cursor: the frame
 * is composited, so the one thing the reader looks for has to be part of it.
 */
function caret(character: string): InputSegment {
  return { text: character, fg: THEME.canvas, bg: THEME.prompt };
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
): readonly InputRow[] {
  const width = Math.max(1, viewport.width);
  const contentWidth = Math.max(1, width - GUTTER_CELLS);
  const live = focused && !model.disabled;
  const empty = model.value.length === 0;
  const valueCells = [...model.value].length;
  const caretAt = Math.max(0, Math.min(model.caret ?? valueCells, valueCells));

  // An empty composer shows the placeholder in the text's place; a disabled one
  // keeps whatever was already typed, because losing sight of a draft to a
  // modal is worse than losing the caret.
  const lines = empty
    ? [clip(model.placeholder, contentWidth)]
    : wrapCells(model.value, contentWidth);
  if (!empty && live && cells(lines[lines.length - 1] ?? "") >= contentWidth) lines.push("");

  // Which wrapped line the caret falls on, and its column within that line —
  // char wrap means this is exact division, no word-boundary guessing.
  const caretLine = empty ? 0 : Math.min(lines.length - 1, Math.floor(caretAt / contentWidth));
  const caretColumn = empty ? 0 : caretAt - caretLine * contentWidth;

  const queued = Math.max(0, model.queued);
  // The chrome row and the text rows share one budget, so the marker that says
  // "there is more above" can never itself push the composer past the cap.
  const capWithChrome = INPUT_MAX_ROWS - 1;
  const capWithoutChrome = queued > 0 ? INPUT_MAX_ROWS - 1 : INPUT_MAX_ROWS;
  let visible = lines;
  let hidden = 0;
  if (lines.length > capWithoutChrome) {
    visible = lines.slice(lines.length - capWithChrome);
    hidden = lines.length - capWithChrome;
  }

  const rows: InputRow[] = [];
  if (hidden > 0 || queued > 0) {
    const left: InputSegment[] =
      hidden > 0
        ? [
            {
              text: `${glyphs.railDeep} ${hidden} more line${hidden === 1 ? "" : "s"}`,
              fg: THEME.muted,
            },
          ]
        : [];
    const right: InputSegment[] =
      queued > 0 ? [{ text: `${queued} queued`, fg: THEME.secondary }] : [];
    rows.push(alignRow("chrome", left, right, width));
  }

  // The caret's own line may have scrolled out of `visible` — the window
  // always shows the *last* capWithChrome lines, so a caret placed earlier in
  // a long multi-line draft can be above it. Clamping it to the top of what is
  // shown keeps a caret visible always, rather than rendering none at all.
  const visibleCaretLine = Math.max(0, caretLine - hidden);

  visible.forEach((line, index) => {
    const marker: InputSegment =
      index === 0
        ? { text: `${glyphs.promptCursor} `, fg: live ? THEME.prompt : THEME.muted }
        : { text: " ".repeat(GUTTER_CELLS), fg: THEME.muted };

    const body: InputSegment[] = [];
    const onCaretLine = live && index === visibleCaretLine;
    if (empty) {
      const characters = [...line];
      const head = characters[0] ?? " ";
      // The caret sits *on* the placeholder's first cell rather than beside it,
      // so an empty composer is one column wide instead of two.
      if (live) body.push(caret(head), { text: characters.slice(1).join(""), fg: THEME.muted });
      else body.push({ text: line, fg: THEME.muted });
    } else if (onCaretLine) {
      const characters = [...line];
      const column = Math.min(caretColumn, characters.length);
      const before = characters.slice(0, column).join("");
      const onCell = characters[column] ?? " ";
      const after = characters.slice(column + 1).join("");
      const fg = model.disabled ? THEME.muted : THEME.selected;
      body.push({ text: before, fg }, caret(onCell));
      if (after.length > 0) body.push({ text: after, fg });
    } else {
      body.push({ text: line, fg: model.disabled ? THEME.muted : THEME.selected });
    }

    rows.push({ key: `line:${String(index)}`, segments: [marker, ...body] });
  });

  return rows;
}

export function Input({ model, viewport, focused }: InputProps): ReactNode {
  const rows = inputRows(model, viewport, focused ?? !model.disabled);

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
