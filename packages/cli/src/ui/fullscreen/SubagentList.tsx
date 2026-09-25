/** @jsxImportSource @opentui/react */

/**
 * This turn's sub-agents, under the composer.
 *
 *   3 subagents running                                      down to manage
 *     ▝ Sudoku race: Haiku  ∙ read_file board.txt                    12s
 *   > ▗ Sudoku race: Sonnet ∙ checking box 6                         12s
 *     + Sudoku race: Opus   ∙ solved in 41 moves                      9s
 *
 * The header is always there while the turn has delegated work, so the way in is
 * never hidden. The per-agent rows show while anything is still running, or while
 * the list has the keyboard: once every agent has finished, one row saying so is
 * all the room it earns until someone asks to look.
 */

import { memo, useEffect, useState, type ReactNode } from "react";
import { getGlyphs, type GlyphSet } from "../glyphs";
import { MOTION, THEME } from "../theme";
import { alignRow, formatElapsed, type LiveRow, type LiveSegment } from "./LiveZone";
import type { SubagentListItem, SubagentListModel, Viewport } from "./types";

/**
 * Agent rows shown at once. Parallel fan-outs past this are rare, and the band sits
 * between the composer and the footer, so every row it takes is a transcript row.
 */
export const SUBAGENT_LIST_MAX_ITEMS = 5;

function statusCell(
  item: SubagentListItem,
  index: number,
  tick: number,
  glyphs: GlyphSet,
): LiveSegment {
  switch (item.status) {
    case "running": {
      const frames = glyphs.spinnerFrames;
      return { text: frames[(tick + index) % frames.length] ?? glyphs.active, fg: THEME.primary };
    }
    case "completed":
      return { text: glyphs.success, fg: THEME.success };
    case "failed":
      return { text: glyphs.error, fg: THEME.error };
    case "interrupted":
      return { text: glyphs.error, fg: THEME.muted };
  }
}

function headerText(items: readonly SubagentListItem[]): string {
  const running = items.filter((item) => item.status === "running").length;
  const noun = items.length === 1 ? "subagent" : "subagents";
  if (running === items.length) return `${String(items.length)} ${noun} running`;
  if (running === 0) return `${String(items.length)} ${noun} finished`;
  return `${String(running)} of ${String(items.length)} ${noun} running`;
}

function showsItems(model: SubagentListModel): boolean {
  return (
    model.selected !== undefined ||
    model.inspecting !== undefined ||
    model.items.some((item) => item.status === "running")
  );
}

/** The window of items that keeps the selection on screen. */
function visibleWindow(model: SubagentListModel): { start: number; end: number } {
  const count = model.items.length;
  if (count <= SUBAGENT_LIST_MAX_ITEMS) return { start: 0, end: count };
  const slots = SUBAGENT_LIST_MAX_ITEMS - 1;
  const focus = model.selected ?? 0;
  const start = Math.max(0, Math.min(focus - slots + 1, count - slots));
  return { start, end: start + slots };
}

/**
 * The rows the band draws, each exactly the viewport's width. Pure and exported
 * because the band's height feeds the layout arithmetic before anything renders.
 */
export function subagentListRows(
  model: SubagentListModel | undefined,
  viewport: Viewport,
  glyphs: GlyphSet = getGlyphs(),
  tick = 0,
): readonly LiveRow[] {
  if (model === undefined || model.items.length === 0) return [];
  const width = Math.max(1, viewport.width);
  const focused = model.selected !== undefined;
  const rows: LiveRow[] = [
    alignRow(
      "subagents:header",
      [
        { text: " ", fg: THEME.muted },
        { text: headerText(model.items), fg: focused ? THEME.secondary : THEME.muted },
      ],
      [{ text: focused ? "enter to open" : "down to manage", fg: THEME.muted }],
      width,
    ),
  ];
  if (!showsItems(model)) return rows;

  const { start, end } = visibleWindow(model);
  for (let index = start; index < end; index++) {
    const item = model.items[index];
    if (item === undefined) continue;
    const selected = model.selected === index;
    const inspected = model.inspecting === item.id;
    const left: LiveSegment[] = [
      { text: " ", fg: THEME.muted },
      selected ? { text: glyphs.promptCursor, fg: THEME.primary } : { text: " ", fg: THEME.muted },
      { text: " ", fg: THEME.muted },
      statusCell(item, index, tick, glyphs),
      { text: " ", fg: THEME.muted },
      {
        text: item.label,
        fg: selected || inspected ? THEME.selected : THEME.secondary,
      },
    ];
    if (item.activity.length > 0) {
      left.push(
        { text: ` ${glyphs.bullet} `, fg: THEME.muted },
        {
          text: item.activity,
          fg: THEME.muted,
        },
      );
    }
    rows.push(
      alignRow(
        `subagents:${item.id}`,
        left,
        [{ text: formatElapsed(item.elapsedMs), fg: THEME.muted }],
        width,
      ),
    );
  }
  const hidden = model.items.length - (end - start);
  if (hidden > 0) {
    rows.push(
      alignRow(
        "subagents:overflow",
        [{ text: `     +${String(hidden)} more`, fg: THEME.muted }],
        [],
        width,
      ),
    );
  }
  return rows;
}

export interface SubagentListProps {
  readonly model: SubagentListModel | undefined;
  readonly viewport: Viewport;
  /** Rows the shell can spare; the header survives, agent rows go from the bottom. */
  readonly maxRows?: number;
}

function SubagentListView({ model, viewport, maxRows }: SubagentListProps): ReactNode {
  const [tick, setTick] = useState(0);
  const animate = model?.items.some((item) => item.status === "running") ?? false;

  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => {
      setTick((value) => value + 1);
    }, MOTION.indicator);
    return () => clearInterval(timer);
  }, [animate]);

  const allRows = subagentListRows(model, viewport, undefined, tick);
  const rows = maxRows === undefined ? allRows : allRows.slice(0, Math.max(0, maxRows));
  if (rows.length === 0) return null;

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

export const SubagentList = memo(SubagentListView);
