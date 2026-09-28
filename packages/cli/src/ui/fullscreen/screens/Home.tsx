/** @jsxImportSource @opentui/react */

/**
 * The home screen.
 *
 * `jazz` with no arguments starts here. It leads with what is waiting for you:
 * conversations where an agent is blocked on your answer, then the ones you
 * were last in, each reopened with its number key. Below them, every action is
 * one key, and one muted line says how the setup stands.
 *
 * With no agent yet it is the first-run screen instead: what jazz is, the three
 * steps setup takes, and anything already on the machine that shortens them.
 *
 * Height is a budget. The status line goes first when the terminal is short,
 * then conversations from the bottom of the list, then the greeting; the
 * actions and the footer are never dropped. Leftover height sits mostly below
 * the block, so a tall terminal holds the screen in its upper third.
 *
 * No keys are handled here: the screen renders its model and nothing else.
 */

import type { ReactNode } from "react";
import { getGlyphs, type GlyphSet } from "../../glyphs";
import {
  FIRST_RUN_PITCH,
  FIRST_RUN_PROMISE,
  FIRST_RUN_SETUP_LEAD,
  FIRST_RUN_STEPS,
  conversationTag,
  detectionLines,
  homeLead,
  homeLegend,
  type HomeConversation,
  type HomeModel,
  type HomeStatus,
  type LegendEntry,
} from "../../models/home-view";
import { groundPaint, THEME } from "../../theme";
import { clipTerminalCells, terminalCellWidth } from "../terminal-cells";
import { pageWidth } from "../Transcript";
import { measureFor, type Viewport } from "../types";

export type { HomeModel } from "../../models/home-view";

/** The bar cell plus one space; text inside a band starts here. */
const GUTTER = 2;

/** Blank cells kept between a band's text and its right-aligned tag. */
const TAG_GAP = 2;

/** Spaces between two actions on one legend row. */
const ACTION_GAP = 4;

/** The footer is anchored to the last viewport row and is never dropped. */
const FOOTER_ROWS = 1;

/** Share of the leftover height placed above the block; the rest goes below it. */
const TOP_SLACK_SHARE = 1 / 3;

export interface HomeProps {
  readonly model: HomeModel;
  readonly viewport: Viewport;
}

export interface Segment {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

export interface HomeRow {
  readonly key: string;
  readonly segments: readonly Segment[];
  /** Background for the whole band width, when the row is part of a band. */
  readonly fill?: string;
}

function cells(text: string): number {
  return terminalCellWidth(text);
}

function clip(text: string, width: number): string {
  return clipTerminalCells(text, Math.max(0, width));
}

function segmentsWidth(segments: readonly Segment[]): number {
  return segments.reduce((total, segment) => total + cells(segment.text), 0);
}

function blank(key: string): HomeRow {
  return { key, segments: [] };
}

function indented(key: string, segments: readonly Segment[], width: number): HomeRow {
  return {
    key,
    segments: clipSegments([{ text: " ".repeat(GUTTER), fg: THEME.muted }, ...segments], width),
  };
}

/** Cut a run of segments to `width` cells, dropping whatever starts past the edge. */
function clipSegments(segments: readonly Segment[], width: number): Segment[] {
  const kept: Segment[] = [];
  let used = 0;
  for (const segment of segments) {
    const room = width - used;
    if (room <= 0) {
      break;
    }
    const text = cells(segment.text) <= room ? segment.text : clip(segment.text, room);
    kept.push({ ...segment, text });
    used += cells(text);
  }
  return kept;
}

/**
 * One band row: a bar (or a blank cell) in the gutter, content on the left, a tag flush right.
 * The tag gives way before the content does.
 */
function bandRow(
  key: string,
  bar: string | null,
  left: readonly Segment[],
  right: readonly Segment[],
  width: number,
  glyphs: GlyphSet,
): HomeRow {
  const inner = width - GUTTER;
  const rightWidth = segmentsWidth(right);
  const showRight = rightWidth > 0 && segmentsWidth(left) + TAG_GAP + rightWidth <= inner;
  const leftRoom = showRight ? inner - rightWidth - TAG_GAP : inner;
  const clippedLeft = clipSegments(left, leftRoom);
  const gap = Math.max(0, inner - segmentsWidth(clippedLeft) - (showRight ? rightWidth : 0));
  return {
    key,
    fill: THEME.surface,
    segments: [
      { text: bar === null ? " " : glyphs.bandBar, fg: bar ?? THEME.muted },
      { text: " ", fg: THEME.muted },
      ...clippedLeft,
      { text: " ".repeat(gap), fg: THEME.muted },
      ...(showRight ? right : []),
    ],
  };
}

function identityRows(): HomeRow[] {
  const glyphs = getGlyphs();
  return [
    {
      key: "identity",
      segments: [
        { text: " ", fg: THEME.muted },
        { text: glyphs.note, fg: THEME.primary },
        { text: " jazz", fg: THEME.selected, bold: true },
      ],
    },
  ];
}

function greetingRows(model: HomeModel, width: number): HomeRow[] {
  if (model.greeting.length === 0) {
    return [];
  }
  const lead = homeLead(model);
  return [
    indented(
      "greeting",
      [
        { text: model.greeting, fg: THEME.selected },
        ...(lead.length > 0 ? [{ text: ` ${lead}`, fg: THEME.secondary }] : []),
      ],
      width,
    ),
  ];
}

function conversationRows(
  conversations: readonly HomeConversation[],
  width: number,
  glyphs: GlyphSet,
): HomeRow[][] {
  return conversations.map((conversation) => {
    const bar = conversation.waiting ? THEME.primary : null;
    return [
      bandRow(
        `conversation:${conversation.value}:title`,
        bar,
        [
          { text: `${conversation.key}  `, fg: THEME.muted },
          { text: conversation.title, fg: THEME.selected, bold: true },
          { text: `  ${conversation.agent}`, fg: THEME.muted },
        ],
        [
          {
            text: conversationTag(conversation),
            fg: conversation.waiting ? THEME.primary : THEME.muted,
          },
        ],
        width,
        glyphs,
      ),
      bandRow(
        `conversation:${conversation.value}:detail`,
        bar,
        [
          { text: " ".repeat(cells(`${conversation.key}  `)), fg: THEME.muted },
          {
            text: conversation.detail,
            fg: conversation.waiting ? THEME.secondary : THEME.muted,
          },
        ],
        [],
        width,
        glyphs,
      ),
    ];
  });
}

function legendSegments(entry: LegendEntry): Segment[] {
  return [
    { text: entry.key, fg: THEME.selected, bold: true },
    { text: ` ${entry.label}`, fg: THEME.secondary },
  ];
}

function joinEntries(entries: readonly LegendEntry[]): Segment[] {
  return entries.flatMap((entry, index) => [
    ...(index > 0 ? [{ text: " ".repeat(ACTION_GAP), fg: THEME.muted }] : []),
    ...legendSegments(entry),
  ]);
}

/**
 * The legend: enter and the number keys lead on a row of their own; the rest flow onto as many
 * rows as the width needs.
 */
function actionRows(model: HomeModel, width: number): HomeRow[] {
  const inner = width - GUTTER;
  const legend = homeLegend(model);
  const rows: HomeRow[] = [];
  if (legend.primary.length > 0) {
    rows.push(indented("actions:primary", joinEntries(legend.primary), width));
  }
  let line: LegendEntry[] = [];
  for (const entry of legend.rest) {
    const candidate = [...line, entry];
    if (line.length > 0 && segmentsWidth(joinEntries(candidate)) > inner) {
      rows.push(indented(`actions:${String(rows.length)}`, joinEntries(line), width));
      line = [entry];
    } else {
      line = candidate;
    }
  }
  if (line.length > 0)
    rows.push(indented(`actions:${String(rows.length)}`, joinEntries(line), width));
  return rows;
}

function statusRows(status: readonly HomeStatus[], width: number, glyphs: GlyphSet): HomeRow[] {
  if (status.length === 0) {
    return [];
  }
  const segments: Segment[] = [];
  status.forEach((part, index) => {
    if (index > 0) segments.push({ text: ` ${glyphs.bullet} `, fg: THEME.muted });
    segments.push({ text: part.text, fg: part.tone === "warning" ? THEME.warning : THEME.muted });
    if (part.fixKey !== undefined) {
      segments.push({ text: `  ${part.fixKey}`, fg: THEME.selected, bold: true });
    }
  });
  return [indented("status", segments, width)];
}

function firstRunRows(model: HomeModel, width: number, glyphs: GlyphSet): HomeRow[] {
  const detected = detectionLines(model);
  const steps: Segment[] = [];
  FIRST_RUN_STEPS.forEach((step, index) => {
    if (index > 0) steps.push({ text: " ".repeat(ACTION_GAP), fg: THEME.muted });
    steps.push(
      { text: String(index + 1), fg: THEME.primary, bold: true },
      { text: ` ${step}`, fg: THEME.selected },
    );
  });
  const rows: HomeRow[] = [
    blank("gap:pitch"),
    indented("pitch", [{ text: FIRST_RUN_PITCH, fg: THEME.selected }], width),
    indented("promise", [{ text: FIRST_RUN_PROMISE, fg: THEME.secondary }], width),
    blank("gap:steps"),
    indented("setup-lead", [{ text: FIRST_RUN_SETUP_LEAD, fg: THEME.muted }], width),
    indented("setup-steps", steps, width),
  ];
  if (detected.length > 0) {
    rows.push(blank("gap:detected"));
    rows.push(bandRow("detected:top", THEME.success, [], [], width, glyphs));
    detected.forEach((detection, index) => {
      rows.push(
        bandRow(
          `detected:${String(index)}`,
          THEME.success,
          [
            { text: `${detection.lead} `, fg: THEME.secondary },
            { text: detection.label, fg: THEME.selected, bold: true },
            { text: ` ${detection.detail}`, fg: THEME.secondary },
          ],
          [],
          width,
          glyphs,
        ),
      );
    });
    rows.push(bandRow("detected:bottom", THEME.success, [], [], width, glyphs));
  }
  return rows;
}

/**
 * The screen above the footer, as rows. Pure: a model and a viewport, nothing else, which is
 * what lets a test assert the design rather than the markup.
 */
export function homeRows(model: HomeModel, viewport: Viewport): HomeRow[] {
  const glyphs = getGlyphs();
  const width = measureFor(pageWidth(viewport)).prose + GUTTER;
  const budget = Math.max(1, viewport.height - FOOTER_ROWS);
  const actions = actionRows(model, width);
  const identity = identityRows();

  if (model.firstRun !== undefined) {
    const rows = [
      ...identity,
      ...firstRunRows(model, width, glyphs),
      blank("gap:actions"),
      ...actions,
    ];
    // The pitch is what the screen is for, and the actions are how you act on it; when the
    // terminal cannot hold both, the actions win and the pitch is cut from the top.
    return rows.length <= budget ? rows : rows.slice(rows.length - budget);
  }

  const greeting = greetingRows(model, width);
  const conversations = conversationRows(model.conversations, width, glyphs);
  const status = statusRows(model.status, width, glyphs);
  let shownConversations = conversations.length;
  let showStatus = status.length > 0;
  let showGreeting = greeting.length > 0;

  const build = (): HomeRow[] => {
    const rows: HomeRow[] = [...identity];
    if (showGreeting) rows.push(blank("gap:greeting"), ...greeting);
    const shown = conversations.slice(0, shownConversations);
    if (shown.length > 0) rows.push(blank("gap:conversations"));
    shown.forEach((entry, index) => {
      if (index > 0) rows.push(blank(`gap:conversation:${String(index)}`));
      rows.push(...entry);
    });
    rows.push(blank("gap:actions"), ...actions);
    if (showStatus) rows.push(blank("gap:status"), ...status);
    return rows;
  };

  let rows = build();
  while (rows.length > budget) {
    if (showStatus) {
      showStatus = false;
    } else if (shownConversations > 0) {
      shownConversations -= 1;
    } else if (showGreeting) {
      showGreeting = false;
    } else {
      return rows.slice(0, budget);
    }
    rows = build();
  }
  return rows;
}

function Row({ row, width }: { row: HomeRow; width: number }): ReactNode {
  if (row.segments.length === 0) return <box style={{ height: 1, flexShrink: 0 }} />;
  return (
    <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
      <box
        style={{
          width,
          height: 1,
          flexShrink: 0,
          ...(row.fill === undefined ? {} : { backgroundColor: row.fill }),
        }}
      >
        <text style={{ wrapMode: "none", truncate: true }}>
          {row.segments.map((segment, index) => {
            const style = {
              fg: segment.fg,
              ...(segment.italic === true ? { italic: true } : {}),
            };
            const key = `${String(index)}:${segment.text}`;
            return segment.bold === true ? (
              <b
                key={key}
                style={style}
              >
                {segment.text}
              </b>
            ) : (
              <span
                key={key}
                style={style}
              >
                {segment.text}
              </span>
            );
          })}
        </text>
      </box>
    </box>
  );
}

/** Blank rows above the block, a third of what the terminal has left over. */
export function homeTopSlack(rowCount: number, viewport: Viewport): number {
  const slack = viewport.height - FOOTER_ROWS - rowCount;
  return Math.max(0, Math.floor(slack * TOP_SLACK_SHARE));
}

/** The footer: the version on the left, the working directory flush right. */
export function homeFooterText(
  model: HomeModel,
  viewport: Viewport,
): { left: string; right: string } {
  const left = ` jazz ${model.version}`;
  const room = viewport.width - cells(left) - TAG_GAP;
  return { left, right: room > 0 ? clip(model.cwd, room) : "" };
}

export function Home({ model, viewport }: HomeProps): ReactNode {
  const rows = homeRows(model, viewport);
  const topSlack = homeTopSlack(rows.length, viewport);
  const width = measureFor(pageWidth(viewport)).prose + GUTTER;
  const footer = homeFooterText(model, viewport);
  return (
    <box
      style={{
        width: viewport.width,
        height: viewport.height,
        flexDirection: "column",
        backgroundColor: groundPaint(),
      }}
    >
      {topSlack > 0 ? <box style={{ height: topSlack, flexShrink: 0 }} /> : null}
      {rows.map((row) => (
        <Row
          key={row.key}
          row={row}
          width={Math.min(width, viewport.width)}
        />
      ))}
      <box style={{ flexGrow: 1 }} />
      <box style={{ height: FOOTER_ROWS, flexShrink: 0, flexDirection: "row" }}>
        <text style={{ wrapMode: "none", truncate: true }}>
          <span style={{ fg: THEME.muted }}>{footer.left}</span>
        </text>
        <box style={{ flexGrow: 1 }} />
        <text style={{ wrapMode: "none", truncate: true }}>
          <span style={{ fg: THEME.muted }}>{footer.right}</span>
        </text>
        <box style={{ width: 1, flexShrink: 0 }} />
      </box>
    </box>
  );
}
