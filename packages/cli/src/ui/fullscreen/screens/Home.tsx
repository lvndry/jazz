/** @jsxImportSource @opentui/react */

/**
 * The home screen, composer first.
 *
 * It opens on the one thing most visits are for: a new conversation. The filled button names
 * the agent it goes to, and the composer under it sends the first message in the same step.
 * The recent agents sit below to re-target both, then whatever is waiting for you. Every word
 * comes from the shared home model; this file only sets it in bands.
 *
 * The block is anchored near the top with room around each section, and the footer holds the
 * last row. When the terminal is short, waiting details go first, then waiting entries from the
 * bottom, then agents other than the chosen one; the button, the composer and the footer stay.
 *
 * No keys are handled here: the screen renders its props and nothing else.
 */

import type { ReactNode } from "react";
import { getGlyphs, type GlyphSet } from "../../glyphs";
import {
  COMPOSER_PLACEHOLDER,
  FIRST_RUN_PITCH,
  FIRST_RUN_PROMISE,
  FIRST_RUN_SETUP_LEAD,
  FIRST_RUN_STEPS,
  agentsHint,
  detectionLines,
  personaLabel,
  targetAgent,
  waitingTag,
  type HomeAgent,
  type HomeModel,
  type HomeWaiting,
} from "../../models/home-view";
import { groundPaint, THEME } from "../../theme";
import { CaretValue } from "../overlays/TextPrompt";
import { clipTerminalCells, terminalCellWidth } from "../terminal-cells";
import { pageWidth } from "../Transcript";
import { measureFor, type Viewport } from "../types";

export type { HomeModel } from "../../models/home-view";

/** The bar cell plus one space; text inside a band starts here. */
const GUTTER = 2;

/** Blank cells kept between a row's text and its right-aligned tag. */
const TAG_GAP = 2;

/** Spaces between two keys in a legend. */
const KEY_GAP = 4;

/** The footer holds the last viewport row. */
const FOOTER_ROWS = 1;

/** Blank rows above the wordmark on a terminal tall enough to spare them. */
const TOP_MARGIN = 2;

/** Terminals at least this tall get two blank rows between sections instead of one. */
const ROOMY_HEIGHT = 40;

/** Column widths for the agent table; a long name or model is cut to fit its column. */
const NAME_COLUMN = 16;
const MODEL_COLUMN = 22;

export interface HomeProps {
  readonly model: HomeModel;
  readonly viewport: Viewport;
  /** The agent a new conversation goes to. */
  readonly selectedId: string | undefined;
  /** What is typed in the composer, and where the caret is. */
  readonly draft: { readonly value: string; readonly caret: number };
}

export interface Segment {
  readonly text: string;
  readonly fg: string;
  readonly bg?: string;
  readonly bold?: boolean;
}

export type HomeRow =
  | {
      readonly key: string;
      readonly kind: "text";
      readonly segments: readonly Segment[];
      /** Background for the whole row width, when the row is part of a band. */
      readonly fill?: string;
    }
  | { readonly key: string; readonly kind: "composer"; readonly agentName: string };

function cells(text: string): number {
  return terminalCellWidth(text);
}

function clip(text: string, width: number): string {
  return clipTerminalCells(text, Math.max(0, width));
}

function widthOf(segments: readonly Segment[]): number {
  return segments.reduce((total, segment) => total + cells(segment.text), 0);
}

/** Cells kept free at the end of a table column, so neighbours never run together. */
const COLUMN_GAP = 2;

function pad(text: string, width: number): string {
  const clipped = clip(text, width - COLUMN_GAP);
  return clipped + " ".repeat(Math.max(0, width - cells(clipped)));
}

function blank(key: string): HomeRow {
  return { key, kind: "text", segments: [] };
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
 * One row: optional bar in the gutter, content on the left, a tag flush right. The tag gives way
 * before the content does. `fill` paints the row as a band.
 */
function row(
  key: string,
  left: readonly Segment[],
  right: readonly Segment[],
  width: number,
  options: { readonly bar?: string | undefined; readonly fill?: string | undefined } = {},
): HomeRow {
  const glyphs = getGlyphs();
  const inner = width - GUTTER;
  const rightWidth = widthOf(right);
  const showRight = rightWidth > 0 && widthOf(left) + TAG_GAP + rightWidth <= inner;
  const clippedLeft = clipSegments(left, showRight ? inner - rightWidth - TAG_GAP : inner);
  const gap = Math.max(0, inner - widthOf(clippedLeft) - (showRight ? rightWidth : 0));
  return {
    key,
    kind: "text",
    ...(options.fill === undefined ? {} : { fill: options.fill }),
    segments: [
      {
        text: options.bar === undefined ? "  " : `${glyphs.bandBar} `,
        fg: options.bar ?? THEME.muted,
      },
      ...clippedLeft,
      { text: " ".repeat(gap), fg: THEME.muted },
      ...(showRight ? right : []),
    ],
  };
}

function wordmark(glyphs: GlyphSet): HomeRow {
  return {
    key: "wordmark",
    kind: "text",
    segments: [
      { text: "  ", fg: THEME.muted },
      { text: `${glyphs.note} `, fg: THEME.primary },
      { text: "jazz", fg: THEME.selected, bold: true },
    ],
  };
}

function startRows(agent: HomeAgent | undefined, width: number): HomeRow[] {
  if (agent === undefined) {
    return [];
  }
  return [
    row(
      "start",
      [
        { text: " + New conversation ", fg: THEME.canvas, bg: THEME.primary, bold: true },
        { text: "  with ", fg: THEME.muted },
        { text: agent.name, fg: THEME.selected, bold: true },
        { text: `  ${agent.model}`, fg: THEME.muted },
      ],
      [{ text: "enter", fg: THEME.selected, bold: true }],
      width,
    ),
  ];
}

function composerRows(agent: HomeAgent | undefined, width: number): HomeRow[] {
  if (agent === undefined) {
    return [];
  }
  const padRow = (key: string): HomeRow =>
    row(key, [], [], width, { bar: THEME.primary, fill: THEME.surfaceStrong });
  return [
    padRow("composer:top"),
    { key: "composer", kind: "composer", agentName: agent.name },
    padRow("composer:bottom"),
  ];
}

function agentRow(agent: HomeAgent, selected: boolean, width: number): HomeRow {
  const cellsLeft: Segment[] = [
    { text: selected ? "› " : "  ", fg: THEME.primary },
    {
      text: pad(agent.name, NAME_COLUMN),
      fg: selected ? THEME.selected : THEME.secondary,
      bold: selected,
    },
    { text: pad(agent.model, MODEL_COLUMN), fg: THEME.muted },
    { text: personaLabel(agent.persona), fg: THEME.muted },
  ];
  return row(
    `agent:${agent.id}`,
    cellsLeft,
    agent.lastUsed === undefined ? [] : [{ text: agent.lastUsed, fg: THEME.muted }],
    width,
    selected ? { fill: THEME.surfaceStrong } : {},
  );
}

function heading(key: string, text: string, hint: string, width: number): HomeRow {
  return row(
    key,
    [{ text, fg: THEME.secondary, bold: true }],
    hint.length === 0 ? [] : [{ text: hint, fg: THEME.muted }],
    width,
  );
}

function waitingRows(entry: HomeWaiting, width: number, withDetail: boolean): HomeRow[] {
  const band = { bar: THEME.primary, fill: THEME.surface };
  const rows = [
    row(
      `waiting:${entry.value}`,
      [
        { text: `${entry.key}  `, fg: THEME.muted },
        { text: entry.title, fg: THEME.selected, bold: true },
        { text: `  ${entry.agent}`, fg: THEME.muted },
      ],
      [{ text: waitingTag(entry.reason, entry.age), fg: THEME.primary }],
      width,
      band,
    ),
  ];
  if (withDetail && entry.detail !== undefined) {
    const indent = " ".repeat(cells(`${entry.key}  `));
    const room = width - GUTTER - cells(indent);
    const detail = clip(entry.detail, room);
    rows.push(
      row(
        `waiting:${entry.value}:detail`,
        [
          { text: indent, fg: THEME.muted },
          { text: detail, fg: THEME.secondary },
        ],
        [],
        width,
        band,
      ),
    );
  }
  return rows;
}

function firstRunRows(model: HomeModel, width: number): HomeRow[] {
  const steps: Segment[] = FIRST_RUN_STEPS.flatMap((step, index) => [
    ...(index > 0 ? [{ text: " ".repeat(KEY_GAP), fg: THEME.muted }] : []),
    { text: String(index + 1), fg: THEME.primary, bold: true },
    { text: ` ${step}`, fg: THEME.selected },
  ]);
  const rows: HomeRow[] = [
    blank("gap:pitch"),
    row("pitch", [{ text: FIRST_RUN_PITCH, fg: THEME.selected }], [], width),
    row("promise", [{ text: FIRST_RUN_PROMISE, fg: THEME.secondary }], [], width),
    blank("gap:steps"),
    row("setup-lead", [{ text: FIRST_RUN_SETUP_LEAD, fg: THEME.muted }], [], width),
    row("setup-steps", steps, [], width),
  ];
  const detected = detectionLines(model);
  if (detected.length > 0) {
    const band = { bar: THEME.success, fill: THEME.surface };
    rows.push(blank("gap:detected"), row("detected:top", [], [], width, band));
    detected.forEach((line, index) => {
      rows.push(
        row(
          `detected:${String(index)}`,
          [
            { text: `${line.lead} `, fg: THEME.secondary },
            { text: line.label, fg: THEME.selected, bold: true },
            { text: ` ${line.detail}`, fg: THEME.secondary },
          ],
          [],
          width,
          band,
        ),
      );
    });
    rows.push(row("detected:bottom", [], [], width, band));
  }
  rows.push(
    blank("gap:keys"),
    row(
      "first-run-keys",
      model.keys.flatMap((entry, index) => [
        ...(index > 0 ? [{ text: " ".repeat(KEY_GAP), fg: THEME.muted }] : []),
        { text: entry.key, fg: THEME.selected, bold: true },
        { text: ` ${entry.label}`, fg: THEME.secondary },
      ]),
      [],
      width,
    ),
  );
  return rows;
}

/** The width the block is set to: the prose measure plus the gutter, never past the window. */
export function homeWidth(viewport: Viewport): number {
  return Math.min(viewport.width, measureFor(pageWidth(viewport)).prose + GUTTER);
}

/**
 * The screen above the footer, as rows. Pure: the props and nothing else, which is what lets a
 * test assert the design rather than the markup.
 */
export function homeRows(
  model: HomeModel,
  viewport: Viewport,
  selectedId: string | undefined,
): HomeRow[] {
  const glyphs = getGlyphs();
  const width = homeWidth(viewport);
  const budget = Math.max(1, viewport.height - FOOTER_ROWS);
  const gapRows = viewport.height >= ROOMY_HEIGHT ? 2 : 1;
  const gap = (key: string): HomeRow[] =>
    Array.from({ length: gapRows }, (_, index) => blank(`${key}:${String(index)}`));

  if (model.firstRun !== undefined) {
    const rows = [...gap("top"), wordmark(glyphs), ...firstRunRows(model, width)];
    return rows.length <= budget ? rows : rows.slice(rows.length - budget);
  }

  const target = targetAgent(model, selectedId);
  let shownAgents = model.agents.length;
  let shownWaiting = model.waiting.length;
  let details = true;
  let topMargin = Math.min(TOP_MARGIN, gapRows + 1);

  const build = (): HomeRow[] => {
    const rows: HomeRow[] = [
      ...Array.from({ length: topMargin }, (_, index) => blank(`top:${String(index)}`)),
      wordmark(glyphs),
      ...gap("start"),
      ...startRows(target, width),
      blank("gap:composer"),
      ...composerRows(target, width),
    ];
    // The chosen agent always stays in view, whatever else has to give way.
    const agents = model.agents.filter(
      (agent, index) => index < shownAgents || agent.id === target?.id,
    );
    if (agents.length > 0) {
      rows.push(
        ...gap("agents"),
        heading("agents:heading", "Start with another agent", agentsHint(model), width),
        ...agents.map((agent) => agentRow(agent, agent.id === target?.id, width)),
      );
    }
    const waiting = model.waiting.slice(0, shownWaiting);
    if (waiting.length > 0) {
      rows.push(
        ...gap("waiting"),
        heading("waiting:heading", "Waiting for you", String(model.waiting.length), width),
        ...waiting.flatMap((entry) => waitingRows(entry, width, details)),
      );
    }
    return rows;
  };

  let rows = build();
  while (rows.length > budget) {
    if (topMargin > 0) {
      topMargin -= 1;
    } else if (details && shownWaiting > 0) {
      details = false;
    } else if (shownWaiting > 0) {
      shownWaiting -= 1;
    } else if (shownAgents > 1) {
      shownAgents -= 1;
    } else {
      return rows.slice(0, budget);
    }
    rows = build();
  }
  return rows;
}

function SegmentsText({ segments }: { segments: readonly Segment[] }): ReactNode {
  return (
    <text style={{ wrapMode: "none", truncate: true }}>
      {segments.map((segment, index) => {
        const style = {
          fg: segment.fg,
          ...(segment.bg === undefined ? {} : { bg: segment.bg }),
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
  );
}

function Composer({
  width,
  agentName,
  draft,
}: {
  width: number;
  agentName: string;
  draft: HomeProps["draft"];
}): ReactNode {
  const glyphs = getGlyphs();
  const hint = `enter sends to ${agentName}`;
  const room = width - GUTTER - TAG_GAP - cells(hint) - 1;
  const showHint = room >= cells(COMPOSER_PLACEHOLDER) / 2;
  return (
    <box
      style={{
        width,
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        backgroundColor: THEME.surfaceStrong,
      }}
    >
      <text
        style={{ fg: THEME.primary, width: GUTTER, flexShrink: 0 }}
      >{`${glyphs.bandBar} `}</text>
      <CaretValue
        value={draft.value}
        caret={draft.caret}
        width={showHint ? room : width - GUTTER - 1}
        placeholder={COMPOSER_PLACEHOLDER}
      />
      <box style={{ flexGrow: 1 }} />
      {showHint ? <text style={{ fg: THEME.muted, flexShrink: 0 }}>{`${hint} `}</text> : null}
    </box>
  );
}

function Row({
  row,
  width,
  draft,
}: {
  row: HomeRow;
  width: number;
  draft: HomeProps["draft"];
}): ReactNode {
  if (row.kind === "composer") {
    return (
      <Composer
        width={width}
        agentName={row.agentName}
        draft={draft}
      />
    );
  }
  if (row.segments.length === 0) {
    return <box style={{ height: 1, flexShrink: 0 }} />;
  }
  return (
    <box
      style={{
        width,
        height: 1,
        flexShrink: 0,
        ...(row.fill === undefined ? {} : { backgroundColor: row.fill }),
      }}
    >
      <SegmentsText segments={row.segments} />
    </box>
  );
}

/** The footer: the single keys on the left, a readiness warning and its fix key on the right. */
export function homeFooterSegments(
  model: HomeModel,
  width: number,
): { left: Segment[]; right: Segment[] } {
  const left: Segment[] =
    model.firstRun !== undefined
      ? []
      : model.keys.flatMap((entry, index) => [
          { text: index === 0 ? "  " : " ".repeat(KEY_GAP), fg: THEME.muted },
          { text: entry.key, fg: THEME.selected, bold: true },
          { text: ` ${entry.label}`, fg: THEME.muted },
        ]);
  const right: Segment[] =
    model.warning === undefined
      ? []
      : [
          { text: model.warning.text, fg: THEME.warning },
          { text: `  ${model.warning.fixKey}`, fg: THEME.selected, bold: true },
          { text: " ", fg: THEME.muted },
        ];
  return widthOf(left) + TAG_GAP + widthOf(right) <= width ? { left, right } : { left, right: [] };
}

export function Home({ model, viewport, selectedId, draft }: HomeProps): ReactNode {
  const rows = homeRows(model, viewport, selectedId);
  const width = homeWidth(viewport);
  const footer = homeFooterSegments(model, viewport.width);
  return (
    <box
      style={{
        width: viewport.width,
        height: viewport.height,
        flexDirection: "column",
        backgroundColor: groundPaint(),
      }}
    >
      {rows.map((entry) => (
        <Row
          key={entry.key}
          row={entry}
          width={width}
          draft={draft}
        />
      ))}
      <box style={{ flexGrow: 1 }} />
      <box style={{ height: FOOTER_ROWS, flexShrink: 0, flexDirection: "row" }}>
        <SegmentsText segments={footer.left} />
        <box style={{ flexGrow: 1 }} />
        <SegmentsText segments={footer.right} />
      </box>
    </box>
  );
}
