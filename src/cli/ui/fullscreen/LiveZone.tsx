/** @jsxImportSource @opentui/react */

/**
 * The live zone: what jazz is doing right now, in exactly one place.
 *
 *   ░▖░▘░ reading your calendar before it answers                       12s
 *   ▎ ╺╺╴╴╴╴╴ step 3 of 7 ∙ rank by urgency
 *   ▎ ▝ gmail ∙ list threads in:inbox newer_than:2d                      4s
 *   ▎ ▗ calendar ∙ freebusy 2026-08-20                                   1s
 *   ▎ +2 more ∙ drive, slack
 *
 * This band replaced a sidebar, and it earns that by never moving. It is
 * pinned above the composer with one quiet row between them, so "what is it
 * doing" is a glance at a fixed spot rather than a hunt across the frame.
 *
 * Two decisions carry the whole region.
 *
 * The band's height is `model.reservedRows` — a high-water mark the adapter
 * grows to fit and only lets fall once the run settles. Tools start and finish
 * several times a second, so a band sized to the tools *currently* running
 * would walk the input up and down under the user's hands; a band that always
 * reserved the cap would pay four blank rows forever for that transient
 * problem. Growing and never shrinking mid-turn is what buys stillness without
 * the waste, and keeping the ratchet in the adapter is what keeps this
 * component a pure function of the model. Content is bottom-anchored inside
 * the reservation, so new work grows *upward* away from the input.
 *
 * Motion is allowed where text is not. The aggregate indicator lives on the
 * waiting row, which exists only before the first token lands — once prose is
 * streaming the reader is reading, and an animation beside running text is a
 * competitor for the eye. Each tool row keeps its own single-cell spinner
 * seeded at `tool.phase`, so three things running look like three things
 * running rather than one thing blinking three times.
 */

import { memo, useEffect, useState, type ReactNode } from "react";
import { highlightCodeLine } from "./syntax-spans";
import { getGlyphs, laneFrame, type GlyphSet } from "../glyphs";
import { MOTION, THEME } from "../theme";
import { fitTerminalSegments, terminalSegmentsWidth } from "./terminal-cells";
import type { TodoSnapshotItem } from "../activity-state";
import {
  LIVE_ZONE_MAX_ROWS,
  type LiveModel,
  type LiveTool,
  type StepLine,
  type Viewport,
} from "./types";

/** Truncation marker. ASCII, because every monospace font has had it since 1970. */
export interface LiveSegment {
  readonly text: string;
  readonly fg: string;
}

export interface LiveRow {
  readonly key: string;
  readonly segments: readonly LiveSegment[];
}

/**
 * Whole seconds, derived from `elapsedMs` alone.
 *
 * The indicator runs at ~6fps and the digits must not: a number changing
 * faster than it can be read is noise wearing the costume of information. This
 * changes at most once a second no matter how often the frame redraws.
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * Left content, then the metadata column flush right, padded to exactly the
 * width. The left side loses characters before the metadata does — an elapsed
 * time you cannot read is worse than an operation name you can infer.
 */
function alignRow(
  key: string,
  left: readonly LiveSegment[],
  right: readonly LiveSegment[],
  width: number,
): LiveRow {
  const rightWidth = terminalSegmentsWidth(right);
  // One column of breathing room, or the metadata column is dropped entirely.
  const leftBudget = width - rightWidth - 1;
  if (leftBudget < 1) {
    return { key, segments: fitTerminalSegments(left, width) };
  }
  const kept = fitTerminalSegments(left, leftBudget);
  const gap = width - terminalSegmentsWidth(kept) - rightWidth;
  const padding: LiveSegment[] = gap > 0 ? [{ text: " ".repeat(gap), fg: THEME.muted }] : [];
  return { key, segments: [...kept, ...padding, ...right] };
}

/** The gutter every enumerated row shares, so the text column lines up. */
function gutter(glyphs: GlyphSet): LiveSegment[] {
  return [{ text: `${glyphs.rail} `, fg: THEME.border }];
}

function separator(glyphs: GlyphSet): LiveSegment {
  return { text: ` ${glyphs.bullet} `, fg: THEME.muted };
}

/**
 * One tool, one row, its own spinner.
 *
 * The phase offset is the point: `(tick + phase)` means two tools started a
 * moment apart show different cells in the same frame, so the row count and
 * the motion agree about how much is happening.
 */
function toolRow(tool: LiveTool, tick: number, glyphs: GlyphSet, width: number): LiveRow {
  const frames = glyphs.spinnerFrames;
  const index = (((tick + tool.phase) % frames.length) + frames.length) % frames.length;
  const cell = frames[index] ?? glyphs.active;
  const operationSpans =
    tool.language === undefined
      ? [{ text: tool.operation, fg: THEME.selected }]
      : highlightCodeLine(tool.operation);
  return alignRow(
    `tool:${tool.app}:${tool.operation}`,
    [
      ...gutter(glyphs),
      { text: cell, fg: THEME.primary },
      { text: " ", fg: THEME.muted },
      { text: tool.app, fg: THEME.secondary },
      separator(glyphs),
      ...operationSpans,
    ],
    [{ text: formatElapsed(tool.elapsedMs), fg: THEME.muted }],
    width,
  );
}

/**
 * The plan is one row, not a panel.
 *
 * A ladder of done/pending marks rides in front of the digits while the plan
 * is short enough for the marks to be countable at a glance; past that the
 * marks stop being readable and the digits do the work alone. Neither moves.
 */
function stepRow(
  step: StepLine,
  runningCount: number,
  elapsedMs: number | undefined,
  glyphs: GlyphSet,
  width: number,
): LiveRow {
  const total = Math.max(1, step.total);
  const index = Math.min(Math.max(1, step.index), total);
  const runningLabel = runningCount > 0 ? `${String(runningCount)} running` : "no tools out";
  const right: LiveSegment[] = [{ text: runningLabel, fg: THEME.muted }];
  if (elapsedMs !== undefined) {
    right.push(separator(glyphs), { text: formatElapsed(elapsedMs), fg: THEME.muted });
  }
  return alignRow(
    "step",
    [
      ...gutter(glyphs),
      { text: `step ${index} of ${total}`, fg: THEME.muted },
      { text: "   ", fg: THEME.muted },
      { text: step.label, fg: THEME.secondary },
    ],
    right,
    width,
  );
}

/**
 * Hidden work is named with a reason, never silently dropped.
 *
 * The count says how much is missing and the names say what, so the collapse
 * is a summary rather than a loss.
 */
function overflowRow(names: readonly string[], glyphs: GlyphSet, width: number): LiveRow {
  return alignRow(
    "overflow",
    [
      ...gutter(glyphs),
      { text: `+${names.length} more`, fg: THEME.muted },
      separator(glyphs),
      { text: names.join(", "), fg: THEME.muted },
    ],
    [],
    width,
  );
}

/**
 * The aggregate indicator and the house-voice copy, on one row.
 *
 * `laneFrame` is the only thing in the product that can count: lanes rest on
 * pairwise-coprime periods, so the number of cells moving tracks how much work
 * is actually in flight instead of spinning at a constant rate forever.
 */
function waitingRow(
  waiting: string,
  elapsedMs: number | undefined,
  tick: number,
  glyphs: GlyphSet,
  width: number,
): LiveRow {
  return alignRow(
    "waiting",
    [
      { text: laneFrame(tick, glyphs), fg: THEME.primary },
      { text: " ", fg: THEME.muted },
      { text: waiting, fg: THEME.secondary },
    ],
    elapsedMs === undefined ? [] : [{ text: formatElapsed(elapsedMs), fg: THEME.muted }],
    width,
  );
}

/**
 * The todo checklist, windowed into the fixed-height band.
 *
 * The agent's plan earns a panel, not a single "step N of M" row: the items
 * themselves are the most useful thing on screen while they are being worked.
 * At most `TODO_WINDOW_ROWS` items show at once, anchored on the first item
 * that isn't done yet — a completed item drops out of the window and the next
 * pending one slides in to take its place, so the band always shows what's
 * running plus what's coming rather than a static slice of the plan. A
 * `+N more` line carries what still doesn't fit rather than silently dropping
 * it. The count rides the header so progress is legible at a glance even
 * while items are scrolled out of view.
 */
export const TODO_WINDOW_ROWS = 10;

function todoGlyph(status: TodoSnapshotItem["status"], glyphs: GlyphSet): string {
  switch (status) {
    case "completed":
      return glyphs.todoDone;
    case "in_progress":
      return glyphs.todoActive;
    case "cancelled":
      return glyphs.todoCancelled;
    case "pending":
    default:
      return glyphs.todoPending;
  }
}

function todoColor(status: TodoSnapshotItem["status"]): string {
  switch (status) {
    case "completed":
      return THEME.success;
    case "in_progress":
      return THEME.agent;
    case "cancelled":
      return THEME.muted;
    case "pending":
    default:
      return THEME.warning;
  }
}

function todoPanelRows(
  todos: readonly TodoSnapshotItem[],
  glyphs: GlyphSet,
  width: number,
  maxRows: number,
): LiveRow[] {
  if (todos.length === 0 || maxRows <= 0) return [];

  const done = todos.filter((todo) => todo.status === "completed").length;
  const header = alignRow(
    "todo-header",
    [...gutter(glyphs), { text: `todo ${done}/${todos.length}`, fg: THEME.muted }],
    [],
    width,
  );

  // One row for the header; the rest of the budget goes to items, capped so
  // the band never asks for more than the window it actually slides, with a
  // possible `+N more` overflow row eating one of those slots.
  const itemSlots = Math.max(0, Math.min(TODO_WINDOW_ROWS, maxRows - 1));
  if (itemSlots === 0) return [header];

  // Slide the window to the first item still in play; everything before it
  // is done and has already scrolled out of view.
  const anchor = todos.findIndex((todo) => todo.status !== "completed");
  const start = anchor < 0 ? Math.max(0, todos.length - itemSlots) : anchor;

  const overflow = todos.length - start - itemSlots;
  const shownCount = overflow > 0 ? itemSlots - 1 : itemSlots;
  const showItems = todos.slice(start, start + Math.max(0, shownCount));
  const itemRows = showItems.map((todo, index) =>
    alignRow(
      `todo:${todo.content}:${start + index}`,
      [
        ...gutter(glyphs),
        { text: todoGlyph(todo.status, glyphs), fg: todoColor(todo.status) },
        { text: " ", fg: THEME.muted },
        { text: todo.content, fg: THEME.secondary },
      ],
      [],
      width,
    ),
  );

  const rows: LiveRow[] = [header, ...itemRows];
  if (overflow > 0) {
    rows.push(
      alignRow(
        "todo-overflow",
        [...gutter(glyphs), { text: `+${overflow} more`, fg: THEME.muted }],
        [],
        width,
      ),
    );
  }
  return rows;
}

export interface LiveZoneProps {
  readonly model: LiveModel;
  readonly viewport: Viewport;
  /**
   * True once prose is landing in the transcript. The adapter already clears
   * `waiting` at the first token; this is the same statement made at the
   * boundary, so a stale `waiting` cannot animate beside running text.
   */
  readonly streaming?: boolean;
  /**
   * Rows the shell can spare. The band is the region that yields first: the
   * transcript and the composer both have to stay on screen, and this is the
   * only one whose content is transient.
   */
  readonly maxRows?: number;
}

/**
 * The rows the band occupies: the adapter's high-water mark, clamped to the cap.
 *
 * This is the band's height, not its content count. The two differ on purpose:
 * mid-turn, a reservation of three with one tool left running is three rows
 * holding still rather than two rows of movement under the user's hands.
 */
export function reservedHeight(model: LiveModel, maxRows = LIVE_ZONE_MAX_ROWS): number {
  const cap = Math.max(0, Math.min(LIVE_ZONE_MAX_ROWS, Math.trunc(maxRows)));
  return Math.min(cap, Math.max(0, Math.trunc(model.reservedRows)));
}

/**
 * The rows the band would draw, top to bottom, each exactly within the width.
 *
 * Pure, and exported, because the band's contract is arithmetic: how many rows
 * exist, which ones survive the reservation, and that no row exceeds the
 * viewport.
 */
export function liveRows(
  model: LiveModel,
  viewport: Viewport,
  streaming = false,
  glyphs: GlyphSet = getGlyphs(),
  maxRows = LIVE_ZONE_MAX_ROWS,
  tick = 0,
): readonly LiveRow[] {
  const width = Math.max(1, viewport.width);
  const capacity = reservedHeight(model, maxRows);
  if (capacity === 0) return [];

  // The todo checklist, when present, is the plan made visible: it earns the
  // band's room ahead of the (redundant) manage_todos tool row. The step row is
  // likewise redundant once the checklist header carries the count, so it yields.
  const showTodo = model.todoList !== undefined && model.todoList.length > 0;
  const otherTools = showTodo ? model.tools.filter((tool) => tool.app !== "manage") : model.tools;

  // Rows are claimed in the order the reader needs them: what is running, then
  // the plan, then the copy. An under-provisioned reservation therefore loses
  // the waiting line first — it is the only row that says nothing about state.
  const demand = otherTools.length + (model.hiddenTools.length > 0 ? 1 : 0);
  let showWaiting = model.waiting !== undefined && !streaming;
  let showStep = model.step !== undefined && !showTodo;
  while ((showWaiting ? 1 : 0) + (showStep ? 1 : 0) + Math.min(demand, 1) > capacity) {
    if (showWaiting) showWaiting = false;
    else if (showStep) showStep = false;
    else break;
  }

  // The adapter may already have collapsed some tools; if so the summary row is
  // owed a slot whether or not the remaining tools overflow on their own.
  const carriedOver = model.hiddenTools.length > 0;
  const reservedForToggles = (showWaiting ? 1 : 0) + (showStep ? 1 : 0);
  let budget = Math.max(0, capacity - reservedForToggles);

  // The checklist takes priority over the (redundant) manage_todos tool row and
  // shares the remaining room with any other tools, windowed with `+N more`.
  const todoPanel: LiveRow[] =
    showTodo && model.todoList !== undefined
      ? todoPanelRows(model.todoList, glyphs, width, budget)
      : [];
  budget = Math.max(0, budget - todoPanel.length);

  let shown = otherTools;
  let dropped: readonly LiveTool[] = [];
  if (otherTools.length + (carriedOver ? 1 : 0) > budget) {
    const slots = Math.max(0, budget - 1);
    shown = otherTools.slice(0, slots);
    dropped = otherTools.slice(slots);
  }
  const hiddenNames = [...dropped.map((tool) => tool.app), ...model.hiddenTools];

  const rows: LiveRow[] = [];
  if (showWaiting && model.waiting !== undefined) {
    rows.push(
      waitingRow(model.waiting, model.reasoningElapsedMs ?? model.elapsedMs, tick, glyphs, width),
    );
  }
  if (showStep && model.step !== undefined) {
    rows.push(
      stepRow(
        model.step,
        model.tools.length + model.hiddenTools.length,
        model.elapsedMs,
        glyphs,
        width,
      ),
    );
  }
  rows.push(...todoPanel);
  for (const tool of shown) rows.push(toolRow(tool, tick, glyphs, width));
  if (hiddenNames.length > 0) rows.push(overflowRow(hiddenNames, glyphs, width));

  return rows;
}

function liveBandAnimates(model: LiveModel, streaming: boolean, maxRows?: number): boolean {
  if (reservedHeight(model, maxRows) === 0) return false;
  if (model.tools.length > 0) return true;
  return model.waiting !== undefined && !streaming;
}

function LiveZoneView({ model, viewport, streaming, maxRows }: LiveZoneProps): ReactNode {
  const [tick, setTick] = useState(0);
  const streamingNow = streaming ?? false;
  const animate = liveBandAnimates(model, streamingNow, maxRows);

  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => {
      setTick((value) => value + 1);
    }, MOTION.indicator);
    return () => clearInterval(timer);
  }, [animate]);

  const height = reservedHeight(model, maxRows);
  const rows = liveRows(model, viewport, streamingNow, undefined, maxRows, tick);

  // The run has settled: the whole band goes away and the transcript takes the
  // rows back. Note this is keyed on the reservation rather than on the rows,
  // so the gap between one tool finishing and the next starting holds its
  // height instead of blinking the input down and back up.
  if (height === 0) return null;

  return (
    <box
      style={{
        width: viewport.width,
        height,
        flexShrink: 0,
        flexDirection: "column",
        justifyContent: "flex-end",
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
                style={{ fg: segment.fg }}
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

export const LiveZone = memo(LiveZoneView);
