/** @jsxImportSource @opentui/react */

/**
 * The home screen, composer first.
 *
 * It opens on the one thing most visits are for: a new conversation. The filled button names
 * the agent it goes to, and the composer under it sends the first message in the same step.
 * The recent agents sit below, then whatever is waiting for you; ↑↓ walks one selection down
 * through both, lifted onto the element band with `›`. `/` opens the same command menu the chat
 * composer has. Every word and every key's meaning comes from the shared home model; this file
 * only sets it in bands.
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
  enterHint,
  focusedWaiting,
  footerHints,
  homeCommandMatches,
  slashQuery,
  targetAgent,
  waitingTag,
  type HomeAgent,
  type HomeModel,
  type HomeState,
  type HomeWaiting,
} from "../../models/home-view";
import { clipTerminalCells, terminalCellWidth } from "../../text/terminal-cells";
import { groundPaint, THEME } from "../../theme";
import { commandSuggestRows } from "../Input";
import { CaretValue } from "../overlays/TextPrompt";
import { measureFor, type Viewport } from "../types";

export type { HomeModel } from "../../models/home-view";

/** The bar cell plus one space; text inside a band starts here. */
const GUTTER = 2;

/** Blank cells kept between a row's text and its right-aligned tag. */
const TAG_GAP = 2;

/** Spaces between two hints in a legend. */
const KEY_GAP = 3;

/** The footer holds the last viewport row. */
const FOOTER_ROWS = 1;

/** Blank rows above the wordmark on a terminal tall enough to spare them. */
const TOP_MARGIN = 2;

/** Terminals at least this tall get two blank rows between sections instead of one. */
const ROOMY_HEIGHT = 40;

/** Column widths for the agent table; a long name or model is cut to fit its column. */
const NAME_COLUMN = 16;
const MODEL_COLUMN = 22;

/** Cells kept free at the end of a table column, so neighbours never run together. */
const COLUMN_GAP = 2;

/** Rows the command menu may take under the composer. */
const MENU_ROWS = 6;

export interface HomeProps {
  readonly model: HomeModel;
  readonly viewport: Viewport;
  /** Where home is: the chosen agent, the selected waiting conversation, the draft. */
  readonly state: HomeState;
  /** Where the caret is in the draft. */
  readonly caret: number;
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
  | { readonly key: string; readonly kind: "composer"; readonly hint: string };

function cells(text: string): number {
  return terminalCellWidth(text);
}

function clip(text: string, width: number): string {
  return clipTerminalCells(text, Math.max(0, width));
}

function widthOf(segments: readonly Segment[]): number {
  return segments.reduce((total, segment) => total + cells(segment.text), 0);
}

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

/**
 * The button. It is filled while enter would start a conversation, and drops to the element
 * plane once the selection is on a waiting conversation, so what is lit is what enter does.
 */
function startRows(agent: HomeAgent | undefined, waiting: boolean, width: number): HomeRow[] {
  if (agent === undefined) {
    return [];
  }
  return [
    row(
      "start",
      [
        waiting
          ? { text: " + New conversation ", fg: THEME.secondary, bg: THEME.surfaceStrong }
          : { text: " + New conversation ", fg: THEME.canvas, bg: THEME.primary, bold: true },
        { text: "  with ", fg: THEME.muted },
        { text: agent.name, fg: waiting ? THEME.secondary : THEME.selected, bold: !waiting },
        { text: `  ${agent.model}`, fg: THEME.muted },
      ],
      waiting ? [] : [{ text: "enter", fg: THEME.selected, bold: true }],
      width,
    ),
  ];
}

function composerRows(hint: string, width: number): HomeRow[] {
  const padRow = (key: string): HomeRow =>
    row(key, [], [], width, { bar: THEME.primary, fill: THEME.surfaceStrong });
  return [
    padRow("composer:top"),
    { key: "composer", kind: "composer", hint },
    padRow("composer:bottom"),
  ];
}

function agentRow(agent: HomeAgent, selected: boolean, width: number): HomeRow {
  const left: Segment[] = [
    { text: selected ? "› " : "  ", fg: THEME.primary },
    {
      text: pad(agent.name, NAME_COLUMN),
      fg: selected ? THEME.selected : THEME.secondary,
      bold: selected,
    },
    { text: pad(agent.model, MODEL_COLUMN), fg: THEME.muted },
    { text: agent.persona, fg: THEME.muted },
  ];
  return row(
    `agent:${agent.id}`,
    left,
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

function waitingRows(
  entry: HomeWaiting,
  selected: boolean,
  width: number,
  withDetail: boolean,
): HomeRow[] {
  const band = { bar: THEME.primary, fill: selected ? THEME.surfaceStrong : THEME.surface };
  const rows = [
    row(
      `waiting:${entry.value}`,
      [
        { text: selected ? "› " : "  ", fg: THEME.primary },
        { text: entry.title, fg: THEME.selected, bold: true },
        { text: `  ${entry.agent}`, fg: THEME.muted },
      ],
      [{ text: waitingTag(entry.reason, entry.age), fg: THEME.primary }],
      width,
      band,
    ),
  ];
  if (withDetail && entry.detail !== undefined) {
    const room = width - GUTTER - 2;
    rows.push(
      row(
        `waiting:${entry.value}:detail`,
        [
          { text: "  ", fg: THEME.muted },
          { text: clip(entry.detail, room), fg: THEME.secondary },
        ],
        [],
        width,
        band,
      ),
    );
  }
  return rows;
}

/** The command menu under the composer, from the chat composer's own row renderer. */
function menuRows(model: HomeModel, state: HomeState, width: number): HomeRow[] {
  const matches = homeCommandMatches(model, state.draft);
  if (matches === undefined) {
    return [];
  }
  if (matches.length === 0) {
    return [
      row(
        "menu:empty",
        [{ text: `No home command starts with ${state.draft}`, fg: THEME.muted }],
        [],
        width,
        { fill: THEME.surface },
      ),
    ];
  }
  const query = slashQuery(state.draft) ?? "";
  return commandSuggestRows(
    {
      items: matches.map((command) => ({ name: command.name, description: command.description })),
      selected: Math.min(state.commandIndex, matches.length - 1),
      prefix: "/",
      query,
    },
    width,
    getGlyphs(),
    MENU_ROWS,
  ).map((menuRow) => ({
    key: `menu:${menuRow.key}`,
    kind: "text" as const,
    segments: menuRow.segments,
    fill: THEME.surface,
  }));
}

function firstRunRows(model: HomeModel, state: HomeState, width: number): HomeRow[] {
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
  rows.push(blank("gap:actions"));
  (model.firstRun?.actions ?? []).forEach((action, index) => {
    const selected = index === state.commandIndex;
    rows.push(
      row(
        `action:${action.value}`,
        [
          { text: selected ? "› " : "  ", fg: THEME.primary },
          { text: action.label, fg: selected ? THEME.selected : THEME.secondary, bold: selected },
        ],
        selected ? [{ text: "enter", fg: THEME.selected, bold: true }] : [],
        width,
        selected ? { fill: THEME.surfaceStrong } : {},
      ),
    );
  });
  return rows;
}

/** The width the block is set to: the prose measure plus the gutter, never past the window. */
export function homeWidth(viewport: Viewport): number {
  return Math.min(viewport.width, measureFor(viewport.width).prose + GUTTER);
}

/**
 * The screen above the footer, as rows. Pure: the props and nothing else, which is what lets a
 * test assert the design rather than the markup.
 */
export function homeRows(model: HomeModel, viewport: Viewport, state: HomeState): HomeRow[] {
  const glyphs = getGlyphs();
  const width = homeWidth(viewport);
  const budget = Math.max(1, viewport.height - FOOTER_ROWS);
  const gapRows = viewport.height >= ROOMY_HEIGHT ? 2 : 1;
  const gap = (key: string): HomeRow[] =>
    Array.from({ length: gapRows }, (_, index) => blank(`${key}:${String(index)}`));

  if (model.firstRun !== undefined) {
    const rows = [...gap("top"), wordmark(glyphs), ...firstRunRows(model, state, width)];
    return rows.length <= budget ? rows : rows.slice(rows.length - budget);
  }

  const target = targetAgent(model, state.agentId);
  const onWaiting = focusedWaiting(model, state) !== undefined;
  const menu = menuRows(model, state, width);
  let shownAgents = model.agents.length;
  let shownWaiting = model.waiting.length;
  let details = true;
  let topMargin = Math.min(TOP_MARGIN, gapRows + 1);

  const build = (): HomeRow[] => {
    const rows: HomeRow[] = [
      ...Array.from({ length: topMargin }, (_, index) => blank(`top:${String(index)}`)),
      wordmark(glyphs),
      ...gap("start"),
      ...startRows(target, onWaiting, width),
      blank("gap:composer"),
      ...(target === undefined ? [] : composerRows(enterHint(model, state) ?? "", width)),
      ...menu,
    ];
    // The chosen agent always stays in view, whatever else has to give way.
    const agents = model.agents.filter(
      (agent, index) => index < shownAgents || agent.id === target?.id,
    );
    if (agents.length > 0) {
      rows.push(
        ...gap("agents"),
        heading("agents:heading", "Start with another agent", agentsHint(model), width),
        ...agents.map((agent) => agentRow(agent, !onWaiting && agent.id === target?.id, width)),
      );
    }
    const waiting = model.waiting.filter(
      (entry, index) => index < shownWaiting || entry.value === state.waitingValue,
    );
    if (waiting.length > 0) {
      rows.push(
        ...gap("waiting"),
        heading("waiting:heading", "Waiting for you", String(model.waiting.length), width),
        ...waiting.flatMap((entry) =>
          waitingRows(entry, entry.value === state.waitingValue, width, details),
        ),
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
  hint,
  draft,
  caret,
}: {
  width: number;
  hint: string;
  draft: string;
  caret: number;
}): ReactNode {
  const glyphs = getGlyphs();
  const room = width - GUTTER - TAG_GAP - cells(hint) - 1;
  const showHint = hint.length > 0 && room >= cells(COMPOSER_PLACEHOLDER) / 2;
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
        value={draft}
        caret={caret}
        width={showHint ? room : width - GUTTER - 1}
        placeholder={COMPOSER_PLACEHOLDER}
      />
      <box style={{ flexGrow: 1 }} />
      {showHint ? <text style={{ fg: THEME.muted, flexShrink: 0 }}>{`${hint} `}</text> : null}
    </box>
  );
}

function Row({
  row: entry,
  width,
  draft,
  caret,
}: {
  row: HomeRow;
  width: number;
  draft: string;
  caret: number;
}): ReactNode {
  if (entry.kind === "composer") {
    return (
      <Composer
        width={width}
        hint={entry.hint}
        draft={draft}
        caret={caret}
      />
    );
  }
  if (entry.segments.length === 0) {
    return <box style={{ height: 1, flexShrink: 0 }} />;
  }
  return (
    <box
      style={{
        width,
        height: 1,
        flexShrink: 0,
        ...(entry.fill === undefined ? {} : { backgroundColor: entry.fill }),
      }}
    >
      <SegmentsText segments={entry.segments} />
    </box>
  );
}

/** The footer: what the keys do on the left, a readiness warning and its fix on the right. */
export function homeFooterSegments(
  model: HomeModel,
  width: number,
): { left: Segment[]; right: Segment[] } {
  const left: Segment[] =
    model.firstRun !== undefined
      ? [
          { text: "  ", fg: THEME.muted },
          { text: "↑↓", fg: THEME.selected, bold: true },
          { text: " choose", fg: THEME.muted },
          { text: " ".repeat(KEY_GAP), fg: THEME.muted },
          { text: "esc", fg: THEME.selected, bold: true },
          { text: " quit", fg: THEME.muted },
        ]
      : footerHints(model).flatMap((hint, index) => [
          { text: index === 0 ? "  " : " ".repeat(KEY_GAP), fg: THEME.muted },
          { text: hint.key, fg: THEME.selected, bold: true },
          { text: ` ${hint.label}`, fg: THEME.muted },
        ]);
  const right: Segment[] =
    model.warning === undefined
      ? []
      : [
          { text: model.warning.text, fg: THEME.warning },
          { text: `  ${model.warning.fix}`, fg: THEME.selected, bold: true },
          { text: " ", fg: THEME.muted },
        ];
  return widthOf(left) + TAG_GAP + widthOf(right) <= width ? { left, right } : { left, right: [] };
}

export function Home({ model, viewport, state, caret }: HomeProps): ReactNode {
  const rows = homeRows(model, viewport, state);
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
          draft={state.draft}
          caret={caret}
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
