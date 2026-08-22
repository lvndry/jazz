/** @jsxImportSource @opentui/react */

/**
 * The home screen.
 *
 * `jazz` with no arguments starts here, which makes this the one screen that has
 * to work when *nothing* is set up — no agent yet. So the design question is not
 * "what is missing" but "what do I do now", and the answer is on screen in three
 * forms: a remedy beside each thing that is not ready, a sentence naming the key
 * to press, and the menu itself.
 *
 * Four things, in this order, because that is the order a reader needs them:
 *
 *   identity   the mark, the version, one line of what this is
 *   setup      what is ready and what is not, each with the one thing to do
 *   menu       what you can do next, selection marked by weight and a rail
 *   tip        one line, dim, ignorable
 *
 * Colour carries one job here. A ready row takes the success mark; a row that
 * is not ready stays on the neutral ramp and spends the accent on its *remedy*,
 * because the remedy is the only thing on the row you would act on. A fresh
 * install therefore has no amber and no red on it — nothing has gone wrong, you
 * simply have not started yet.
 *
 * Height is a budget, not an assumption. The tip goes first when the terminal is
 * short, then the guidance sentence, then the setup list; the menu and the keys
 * row are never dropped, and a menu longer than the space left is windowed
 * around the selection so the selected row is always on screen.
 *
 * No keys are handled here: the screen renders `selected` and nothing else.
 */

import type { ReactNode } from "react";
import { getGlyphs, type GlyphSet } from "../../glyphs";
import { THEME } from "../../theme";
import { clipTerminalCells, terminalCellWidth } from "../terminal-cells";
import { pageWidth } from "../Transcript";
import { measureFor, type Viewport } from "../types";

/** Markers live in the left margin, so the text column never moves. */
const GUTTER = 2;

const COLUMN_GAP = 2;

/** The label column of the setup list, clamped so a long word cannot push prose off. */
const LABEL_MIN = 6;
const LABEL_MAX = 14;

/** The keys row is anchored to the last viewport row and is never dropped. */
const KEYS_ROWS = 1;

/** The guidance sentence gets two rows at most; past that it is a paragraph. */
const GUIDANCE_MAX_ROWS = 2;

/** One thing jazz needs before it is useful, and the one thing to do about it. */
export interface HomeRequirement {
  /** A noun, lowercase: "agent". */
  readonly label: string;
  readonly ready: boolean;
  /** What is true now — "anthropic ∙ claude-sonnet-4", "none yet". */
  readonly detail: string;
  /** What to do about it. Shown instead of the detail while not ready. */
  readonly remedy?: string;
}

/** A menu row. `value` is what the caller routes on; this screen never acts. */
export interface HomeChoice {
  readonly label: string;
  readonly value: string;
  /** A few words on what picking it does. Dropped when the width runs out. */
  readonly hint?: string;
}

export interface HomeModel {
  readonly version: string;
  readonly tagline: string;
  readonly requirements: readonly HomeRequirement[];
  readonly choices: readonly HomeChoice[];
  /** Index into `choices`. Clamped here, so an out-of-range value cannot break a frame. */
  readonly selected: number;
  /** Rotated by the caller, so this screen stays a pure function of its props. */
  readonly tip?: string;
}

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
}

function cells(text: string): number {
  return terminalCellWidth(text);
}

function clip(text: string, width: number): string {
  return clipTerminalCells(text, width);
}

function pad(text: string, width: number): string {
  const missing = width - cells(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function widest(values: readonly string[]): number {
  return values.reduce((most, value) => Math.max(most, cells(value)), 0);
}

/** Greedy word wrap. Long enough for a sentence, which is all this screen sets. */
function wrap(text: string, width: number, maxRows: number): string[] {
  if (width <= 0) return [];
  const rows: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (cells(candidate) <= width) {
      line = candidate;
      continue;
    }
    if (line.length > 0) rows.push(line);
    line = word;
    if (rows.length === maxRows) break;
  }
  if (rows.length < maxRows && line.length > 0) rows.push(line);
  return rows.slice(0, maxRows).map((row, index) =>
    // Only the last row can lose text, and it says so.
    index === maxRows - 1 ? clip(row, width) : row,
  );
}

function blank(key: string): HomeRow {
  return { key, segments: [] };
}

function sectionLabel(key: string, text: string): HomeRow {
  return {
    key,
    segments: [
      { text: " ".repeat(GUTTER), fg: THEME.muted },
      { text, fg: THEME.muted },
    ],
  };
}

/** Two rhythmic voices on one line: five-cell figure against a three-cell one. */
const WORDMARK_ORNAMENT = "▄▀▀▄▀▄▄▀▀▄▄▀▄▀▀▄▀▀▄▀▄▄▀▀▄▄▀▄▀▀▄▀▀▄▀▄▄▀▀▄";

function identityRows(model: HomeModel, glyphs: GlyphSet, content: number): HomeRow[] {
  return [
    {
      key: "ornament",
      segments: [{ text: clip(WORDMARK_ORNAMENT, content + GUTTER), fg: THEME.primary }],
    },
    {
      key: "identity",
      segments: [
        { text: glyphs.note, fg: THEME.primary },
        { text: "  jazz  ", fg: THEME.selected, bold: true },
        { text: model.version, fg: THEME.muted },
      ],
    },
    {
      key: "tagline",
      segments: [
        { text: " ".repeat(GUTTER), fg: THEME.muted },
        { text: clip(model.tagline, content), fg: THEME.muted },
      ],
    },
  ];
}

function requirementRows(
  requirements: readonly HomeRequirement[],
  glyphs: GlyphSet,
  content: number,
): HomeRow[] {
  const labelWidth = clamp(
    widest(requirements.map((requirement) => requirement.label)),
    LABEL_MIN,
    LABEL_MAX,
  );
  return requirements.map((requirement, index) => {
    // The remedy replaces the detail rather than joining it: on a row that is
    // not ready, "none yet" and "create your first one below" say the same thing
    // and only one of them is useful.
    const text = requirement.ready
      ? requirement.detail
      : (requirement.remedy ?? requirement.detail);
    return {
      key: `requirement:${requirement.label}:${String(index)}`,
      segments: [
        {
          text: requirement.ready ? glyphs.active : glyphs.pending,
          fg: requirement.ready ? THEME.success : THEME.muted,
        },
        { text: " ", fg: THEME.muted },
        {
          text: pad(clip(requirement.label, labelWidth), labelWidth + COLUMN_GAP),
          fg: THEME.secondary,
        },
        {
          text: clip(text, Math.max(0, content - labelWidth - COLUMN_GAP)),
          fg: requirement.ready ? THEME.muted : THEME.primary,
        },
      ],
    };
  });
}

function choiceRows(
  choices: readonly HomeChoice[],
  selected: number,
  glyphs: GlyphSet,
  content: number,
): HomeRow[] {
  const labelWidth = Math.min(
    widest(choices.map((choice) => choice.label)),
    Math.max(LABEL_MIN, Math.floor(content / 2)),
  );
  const hintWidth = Math.max(0, content - labelWidth - COLUMN_GAP);
  return choices.map((choice, index) => {
    const isSelected = index === selected;
    const hint = choice.hint ?? "";
    const segments: Segment[] = [
      { text: isSelected ? glyphs.rail : " ", fg: THEME.primary },
      { text: " ", fg: THEME.muted },
      {
        text:
          hint === ""
            ? clip(choice.label, content)
            : pad(clip(choice.label, labelWidth), labelWidth + COLUMN_GAP),
        fg: isSelected ? THEME.selected : THEME.secondary,
        bold: isSelected,
      },
    ];
    if (hint !== "" && hintWidth > 0) {
      segments.push({ text: clip(hint, hintWidth), fg: THEME.muted });
    }
    return { key: `choice:${choice.value}`, segments };
  });
}

function guidanceRows(model: HomeModel, selected: number, content: number): HomeRow[] {
  const choice = model.choices[selected];
  if (choice === undefined) return [];
  const sentence =
    `Nothing is set up yet. Press enter on "${choice.label}" to get started` +
    ` — jazz asks for what it needs as it goes.`;
  return wrap(sentence, content, GUIDANCE_MAX_ROWS).map((text, index) => ({
    key: `guidance:${String(index)}`,
    segments: [
      { text: " ".repeat(GUTTER), fg: THEME.muted },
      { text, fg: THEME.secondary },
    ],
  }));
}

function tipRows(tip: string, glyphs: GlyphSet, content: number): HomeRow[] {
  return [
    {
      key: "tip",
      segments: [
        { text: glyphs.bullet, fg: THEME.muted },
        { text: " ", fg: THEME.muted },
        { text: clip(tip, content), fg: THEME.muted, italic: true },
      ],
    },
  ];
}

/** Keep the selection on screen with the least movement: window around it. */
function windowAround<Item>(
  items: readonly Item[],
  selected: number,
  rows: number,
): readonly Item[] {
  if (items.length <= rows) return items;
  const start = clamp(selected - Math.floor(rows / 2), 0, items.length - rows);
  return items.slice(start, start + rows);
}

/**
 * The screen above the keys row, as rows. Pure: a model and a width, nothing
 * else — which is what lets a test assert the design rather than the markup.
 */
export function homeRows(model: HomeModel, viewport: Viewport): HomeRow[] {
  const glyphs = getGlyphs();
  const content = measureFor(pageWidth(viewport)).prose;
  const budget = Math.max(1, viewport.height - KEYS_ROWS);
  const selected = clamp(model.selected, 0, Math.max(0, model.choices.length - 1));
  const firstRun =
    model.requirements.length > 0 && model.requirements.every((requirement) => !requirement.ready);

  const identity = identityRows(model, glyphs, content);
  const setup =
    model.requirements.length === 0
      ? []
      : [
          blank("gap:setup"),
          sectionLabel("label:setup", "setup"),
          ...requirementRows(model.requirements, glyphs, content),
        ];
  const guidance = firstRun
    ? [blank("gap:guidance"), ...guidanceRows(model, selected, content)]
    : [];
  const tip =
    model.tip === undefined ? [] : [blank("gap:tip"), ...tipRows(model.tip, glyphs, content)];
  const menuHead = [blank("gap:menu"), sectionLabel("label:menu", "what would you like to do?")];
  const choices = choiceRows(model.choices, selected, glyphs, content);

  // Dropped in this order. The tip is decoration, the guidance repeats what the
  // remedies already say, and the setup list is a report; the menu is the only
  // thing you cannot act without.
  const droppable = ["tip", "guidance", "setup"] as const;
  const dropped = new Set<string>();
  let menuRows = choices.length;

  const build = (): HomeRow[] => [
    blank("gap:top"),
    ...identity,
    ...(dropped.has("setup") ? [] : setup),
    ...(dropped.has("guidance") ? [] : guidance),
    ...menuHead,
    ...windowAround(choices, selected, Math.max(1, menuRows)),
    ...(dropped.has("tip") ? [] : tip),
  ];

  let rows = build();
  while (rows.length > budget) {
    const next = droppable.find((name) => !dropped.has(name));
    if (next !== undefined) {
      dropped.add(next);
      rows = build();
      continue;
    }
    if (menuRows > 1) {
      menuRows -= 1;
      rows = build();
      continue;
    }
    // A terminal this short cannot show a menu; the shell's minimum-size notice
    // handles that case, and clipping here keeps this one honest meanwhile.
    return rows.slice(0, budget);
  }
  return rows;
}

function Row({ row }: { row: HomeRow }): ReactNode {
  if (row.segments.length === 0) return <box style={{ height: 1, flexShrink: 0 }} />;
  return (
    <box style={{ height: 1, flexShrink: 0 }}>
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
  );
}

export function Home({ model, viewport }: HomeProps): ReactNode {
  const rows = homeRows(model, viewport);
  return (
    <box
      style={{
        width: viewport.width,
        height: viewport.height,
        flexDirection: "column",
        backgroundColor: THEME.canvas,
      }}
    >
      {rows.map((row) => (
        <Row
          key={row.key}
          row={row}
        />
      ))}
      <box style={{ flexGrow: 1 }} />
      <box style={{ height: KEYS_ROWS, flexShrink: 0, flexDirection: "row" }}>
        <box style={{ width: GUTTER, flexShrink: 0 }} />
        <text style={{ wrapMode: "none", truncate: true }}>
          <b style={{ fg: THEME.selected }}>up down</b>
          <span style={{ fg: THEME.secondary }}>{" move"}</span>
          <span style={{ fg: THEME.muted }}>{"   "}</span>
          <b style={{ fg: THEME.selected }}>enter</b>
          <span style={{ fg: THEME.secondary }}>{" select"}</span>
          <span style={{ fg: THEME.muted }}>{"   "}</span>
          <b style={{ fg: THEME.selected }}>q</b>
          <span style={{ fg: THEME.secondary }}>{" quit"}</span>
        </text>
      </box>
    </box>
  );
}
