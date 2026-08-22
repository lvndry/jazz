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

import type { ReactNode } from "react";
import { getGlyphs, laneFrame, type GlyphSet } from "../glyphs";
import { THEME } from "../theme";
import { fitTerminalSegments, terminalSegmentsWidth } from "./terminal-cells";
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
  return alignRow(
    `tool:${tool.app}:${tool.operation}`,
    [
      ...gutter(glyphs),
      { text: cell, fg: THEME.primary },
      { text: " ", fg: THEME.muted },
      { text: tool.app, fg: THEME.secondary },
      separator(glyphs),
      { text: tool.operation, fg: THEME.selected },
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
): readonly LiveRow[] {
  const width = Math.max(1, viewport.width);
  const capacity = reservedHeight(model, maxRows);
  if (capacity === 0) return [];

  // Rows are claimed in the order the reader needs them: what is running, then
  // the plan, then the copy. An under-provisioned reservation therefore loses
  // the waiting line first — it is the only row that says nothing about state.
  const demand = model.tools.length + (model.hiddenTools.length > 0 ? 1 : 0);
  let showWaiting = model.waiting !== undefined && !streaming;
  let showStep = model.step !== undefined;
  while ((showWaiting ? 1 : 0) + (showStep ? 1 : 0) + Math.min(demand, 1) > capacity) {
    if (showWaiting) showWaiting = false;
    else if (showStep) showStep = false;
    else break;
  }
  const toolBudget = Math.max(0, capacity - (showWaiting ? 1 : 0) - (showStep ? 1 : 0));

  // The adapter may already have collapsed some tools; if so the summary row is
  // owed a slot whether or not the remaining tools overflow on their own.
  const carriedOver = model.hiddenTools.length > 0;
  let shown = model.tools;
  let dropped: readonly LiveTool[] = [];
  if (model.tools.length + (carriedOver ? 1 : 0) > toolBudget) {
    const slots = Math.max(0, toolBudget - 1);
    shown = model.tools.slice(0, slots);
    dropped = model.tools.slice(slots);
  }
  const hiddenNames = [...dropped.map((tool) => tool.app), ...model.hiddenTools];

  const rows: LiveRow[] = [];
  if (showWaiting && model.waiting !== undefined) {
    rows.push(waitingRow(model.waiting, model.elapsedMs, model.tick, glyphs, width));
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
  for (const tool of shown) rows.push(toolRow(tool, model.tick, glyphs, width));
  if (hiddenNames.length > 0) rows.push(overflowRow(hiddenNames, glyphs, width));

  return rows;
}

export function LiveZone({ model, viewport, streaming, maxRows }: LiveZoneProps): ReactNode {
  const height = reservedHeight(model, maxRows);
  const rows = liveRows(model, viewport, streaming ?? false, undefined, maxRows);

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
