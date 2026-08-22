/** @jsxImportSource @opentui/react */

/**
 * The composer: the one region the user's hands are on.
 *
 *   ▏ 4 more lines                                              2 queued
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
 * The trade is real and named: cursor motion, selection and undo have to live
 * in whatever reducer owns `InputModel`. That is the right home for them
 * anyway — the model has to carry a caret offset eventually, and when it does
 * this region renders it without changing shape.
 */

import type { ReactNode } from "react";
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
): InputRow[] {
  const visible = carouselWindow(commands.items, commands.selected, MAX_VISIBLE_COMMANDS);
  const rows: InputRow[] = visible.map((command) => {
    const selected = command === commands.items[commands.selected];
    const usage = command.usage === undefined ? "" : ` ${command.usage}`;
    const skill = command.source === "skill" ? " (skill)" : "";
    const segments: InputSegment[] = [
      { text: selected ? `${glyphs.rail} ` : "  ", fg: THEME.primary },
      { text: `/${command.name}`, fg: selected ? THEME.selected : THEME.secondary },
      ...(usage.length > 0 ? [{ text: usage, fg: THEME.muted }] : []),
      ...(skill.length > 0 ? [{ text: skill, fg: THEME.muted }] : []),
      { text: `  ${command.description}`, fg: THEME.muted },
    ];
    return { key: `cmd:${command.name}`, segments: fitTerminalSegments(segments, width) };
  });
  return rows;
}

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
  const valueCodePoints = [...model.value].length;
  const caretAt = Math.max(0, Math.min(model.caret ?? valueCodePoints, valueCodePoints));

  // An empty composer shows the placeholder in the text's place; a disabled one
  // keeps whatever was already typed, because losing sight of a draft to a
  // modal is worse than losing the caret.
  const lines = empty
    ? [clipTerminalCells(model.placeholder, contentWidth)]
    : wrapCells(model.value, contentWidth);
  if (!empty && live && terminalCellWidth(lines[lines.length - 1] ?? "") >= contentWidth) {
    lines.push("");
  }

  const valueBeforeCaret = [...model.value].slice(0, caretAt).join("");
  const linesBeforeCaret = empty ? [""] : wrapCells(valueBeforeCaret, contentWidth);
  let caretLine = Math.max(0, linesBeforeCaret.length - 1);
  let caretColumn = terminalCellWidth(linesBeforeCaret.at(-1) ?? "");
  if (!empty && caretColumn >= contentWidth) {
    caretLine += 1;
    caretColumn = 0;
  }
  caretLine = Math.min(lines.length - 1, caretLine);

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

  const rows: InputRow[] =
    model.commands === undefined ? [] : commandSuggestRows(model.commands, width, glyphs);
  if (hidden > 0 || queued > 0) {
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
      queued > 0 ? [{ text: `${queued} queued`, fg: THEME.secondary }] : [];
    rows.push(alignRow("chrome", left, right, width));
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
    if (empty) {
      const graphemes = terminalGraphemes(line);
      const head = graphemes[0] ?? " ";
      // The caret sits *on* the placeholder's first cell rather than beside it,
      // so an empty composer is one column wide instead of two.
      if (live) body.push(caret(head), { text: graphemes.slice(1).join(""), fg: THEME.muted });
      else body.push({ text: line, fg: THEME.muted });
    } else if (onCaretLine) {
      const graphemes = terminalGraphemes(line);
      let column = 0;
      let usedCells = 0;
      while (
        column < graphemes.length &&
        usedCells + terminalCellWidth(graphemes[column] as string) <= caretColumn
      ) {
        usedCells += terminalCellWidth(graphemes[column] as string);
        column += 1;
      }
      const before = graphemes.slice(0, column).join("");
      const onCell = graphemes[column] ?? " ";
      const after = graphemes.slice(column + 1).join("");
      const fg = model.disabled ? THEME.muted : THEME.selected;
      body.push({ text: before, fg }, caret(onCell));
      if (after.length > 0) body.push({ text: after, fg });
    } else {
      body.push({ text: line, fg: model.disabled ? THEME.muted : THEME.selected });
    }

    rows.push({ key: `line:${String(index)}`, segments: [rail, marker, ...body] });
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
