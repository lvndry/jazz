/** @jsxImportSource @opentui/react */

/**
 * Agent selection.
 *
 * `jazz` with no arguments lands on the home screen and comes straight here, so
 * this is the last screen before a session starts. What it shows is what tells
 * two agents apart at the moment of choosing: a name, the provider/model behind
 * it, and a one-line description. The id and the creation date — two of the
 * three things the Ink table led with — are lookups, not decisions, so they are
 * not here.
 *
 * Three rules shape it.
 *
 * Selection is weight and a rail, never a background wash: a wash repaints a
 * whole row of the terminal and reads as a modal state, while a bold name with
 * a rail beside it reads as "this one" and survives a monochrome terminal.
 *
 * The description column is dropped whole rather than truncated into noise when
 * the width runs out — the same column priority the Ink list used, for the same
 * reason: three characters of a sentence are worse than no sentence.
 *
 * And no key is handled here. The screen takes `selectedIndex` and renders it,
 * so a frame is reproducible from data alone and input routing stays in one
 * place. A longer-than-the-window list is windowed by arithmetic rather than by
 * a scroll offset the component mutates on a ref — same reason: a scroll
 * position is state, and state is what would make one of these frames depend on
 * the frame before it.
 */

import type { ReactNode } from "react";
import { getGlyphs } from "../../glyphs";
import { THEME } from "../../theme";
import { clipTerminalCells, terminalCellWidth } from "../terminal-cells";
import { pageWidth } from "../Transcript";
import { measureFor, type Viewport } from "../types";

/** Markers live in the left margin, so the name column never moves. */
const GUTTER = 2;

/** Nothing touches the right edge of the page. */
const RIGHT_MARGIN = 2;

const COLUMN_GAP = 2;

/** Name, persona and model stay readable at every width; all are clamped, not stretched. */
const NAME_MIN = 10;
const NAME_MAX = 24;
const MODEL_MIN = 8;
const MODEL_MAX = 36;
const PERSONA_MIN = 8;
const PERSONA_MAX = 20;

/**
 * Below this a description is noise rather than information, so the column goes
 * away entirely. Inherited from the Ink agent list, which drew the same line.
 */
const DESCRIPTION_MIN = 12;

/** Blank, title, blank. */
const HEAD_ROWS = 3;

/** Blank, keys. */
const TAIL_ROWS = 2;

const LAST_USED = "last used";

/** What the screen is for, when the caller does not say. */
const DEFAULT_TITLE = "pick an agent";

/** What enter does, when the caller does not say. */
const DEFAULT_ACTION = "start";

export interface AgentChoice {
  readonly id: string;
  readonly name: string;
  /** The provider and model as the reader would say it, e.g. "anthropic/sonnet-4.5". */
  readonly model: string;
  readonly persona: string;
  readonly description?: string;
  /** The agent this terminal talked to most recently. Caller sorts it first. */
  readonly lastUsed?: boolean;
}

export interface AgentPickerProps {
  readonly agents: readonly AgentChoice[];
  readonly selectedIndex: number;
  readonly viewport: Viewport;
  /**
   * Why the reader is here. The wizard opens this same list to start a chat, to
   * edit an agent and to delete one, and a screen that said "pick an agent" for
   * all three would let someone delete an agent thinking they were opening it.
   */
  readonly title?: string;
  /** The verb on enter — "start", "edit", "delete". Pairs with `title`. */
  readonly action?: string;
}

function cells(text: string): number {
  return terminalCellWidth(text);
}

function clip(text: string, width: number): string {
  return clipTerminalCells(text, width);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function widest(values: readonly string[]): number {
  return values.reduce((most, value) => Math.max(most, cells(value)), 0);
}

export interface AgentColumns {
  readonly name: number;
  readonly model: number;
  readonly persona: number;
  /** Zero when the width cannot carry a description worth reading. */
  readonly description: number;
}

/** Columns sized to the data, clamped, with the description last in priority. */
export function agentColumns(agents: readonly AgentChoice[], content: number): AgentColumns {
  const name = clamp(widest(agents.map((agent) => agent.name)), NAME_MIN, NAME_MAX);
  const model = clamp(widest(agents.map((agent) => agent.model)), MODEL_MIN, MODEL_MAX);
  const persona = clamp(widest(agents.map((agent) => agent.persona)), PERSONA_MIN, PERSONA_MAX);
  const rest = content - name - model - persona - COLUMN_GAP * 3;
  return { name, model, persona, description: rest >= DESCRIPTION_MIN ? rest : 0 };
}

/** Rows the list itself gets: everything the head and the keys row do not take. */
export function listRowsFor(viewport: Viewport): number {
  return Math.max(1, viewport.height - HEAD_ROWS - TAIL_ROWS);
}

/**
 * Which agent the top row shows.
 *
 * The window is a function of the selection alone — not of where the list
 * happened to be scrolled a keystroke ago — so the frame stays reproducible
 * from data and the selection can never be off screen. The selection sits in
 * the middle of the window and the window stops at both ends, which is the
 * behaviour of a list you hold a key down on: the eye keeps a fixed line and
 * the names move past it, except at the top and the bottom where the list has
 * somewhere to stand.
 */
export function windowStart(count: number, selected: number, rows: number): number {
  if (count <= rows) return 0;
  return clamp(selected - Math.floor(rows / 2), 0, count - rows);
}

function positionLabel(agents: readonly AgentChoice[], selected: number): string {
  if (agents.length === 0) return "no agents";
  if (agents.length === 1) return "1 agent";
  return `${String(selected + 1)} of ${String(agents.length)}`;
}

function Keys({ agents, action }: { agents: readonly AgentChoice[]; action: string }): ReactNode {
  if (agents.length === 0) {
    return (
      <text style={{ wrapMode: "none", truncate: true }}>
        <b style={{ fg: THEME.selected }}>esc</b>
        <span style={{ fg: THEME.secondary }}>{" back"}</span>
      </text>
    );
  }
  return (
    <text style={{ wrapMode: "none", truncate: true }}>
      <b style={{ fg: THEME.selected }}>up down</b>
      <span style={{ fg: THEME.secondary }}>{" move"}</span>
      <span style={{ fg: THEME.muted }}>{"   "}</span>
      <b style={{ fg: THEME.selected }}>enter</b>
      <span style={{ fg: THEME.secondary }}>{` ${action}`}</span>
      <span style={{ fg: THEME.muted }}>{"   "}</span>
      <b style={{ fg: THEME.selected }}>esc</b>
      <span style={{ fg: THEME.secondary }}>{" back"}</span>
    </text>
  );
}

export function AgentPicker({
  agents,
  selectedIndex,
  viewport,
  title = DEFAULT_TITLE,
  action = DEFAULT_ACTION,
}: AgentPickerProps): ReactNode {
  const glyphs = getGlyphs();
  const page = pageWidth(viewport);
  const measure = measureFor(page);
  const rows = listRowsFor(viewport);
  const content = Math.max(NAME_MIN + MODEL_MIN + PERSONA_MIN + COLUMN_GAP * 3, measure.prose);
  const columns = agentColumns(agents, content);
  const selected = clamp(selectedIndex, 0, Math.max(0, agents.length - 1));
  const start = windowStart(agents.length, selected, rows);
  const visible = agents.slice(start, start + rows);

  return (
    <box
      style={{
        width: viewport.width,
        height: viewport.height,
        flexDirection: "column",
        backgroundColor: THEME.canvas,
      }}
    >
      <box style={{ height: 1, flexShrink: 0 }} />

      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <text style={{ width: GUTTER, flexShrink: 0, fg: THEME.primary }}>{glyphs.note}</text>
        <text style={{ flexGrow: 1, wrapMode: "none", truncate: true }}>
          <b style={{ fg: THEME.selected }}>{clip(oneLine(title), content)}</b>
        </text>
        <text style={{ flexShrink: 0, fg: THEME.muted }}>{positionLabel(agents, selected)}</text>
        <box style={{ width: RIGHT_MARGIN, flexShrink: 0 }} />
      </box>

      <box style={{ height: 1, flexShrink: 0 }} />

      {agents.length === 0 ? (
        <box style={{ height: rows, flexShrink: 0, flexDirection: "column" }}>
          <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
            <box style={{ width: GUTTER, flexShrink: 0 }} />
            <text style={{ fg: THEME.selected, wrapMode: "none", truncate: true }}>
              No agents yet.
            </text>
          </box>
          <box style={{ height: 1, flexShrink: 0 }} />
          <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
            <box style={{ width: GUTTER, flexShrink: 0 }} />
            <text style={{ fg: THEME.secondary, wrapMode: "none", truncate: true }}>
              {clip("Go back and choose Create agent — it takes about a minute.", content)}
            </text>
          </box>
        </box>
      ) : (
        <box style={{ height: rows, flexShrink: 0, flexDirection: "column" }}>
          {visible.map((agent, offset) => {
            const index = start + offset;
            const isSelected = index === selected;
            const name = clip(oneLine(agent.name), columns.name);
            const model = clip(oneLine(agent.model), columns.model);
            const persona = clip(oneLine(agent.persona), columns.persona);
            const description =
              agent.description === undefined || agent.description === agent.name
                ? ""
                : oneLine(agent.description);
            const tag = agent.lastUsed === true ? LAST_USED : "";
            const descriptionWidth = Math.max(
              0,
              columns.description - (tag === "" ? 0 : cells(tag) + COLUMN_GAP),
            );
            return (
              <box
                key={agent.id}
                style={{ height: 1, flexShrink: 0, flexDirection: "row" }}
              >
                <text style={{ width: GUTTER, flexShrink: 0, fg: THEME.primary }}>
                  {isSelected ? glyphs.rail : " "}
                </text>
                <box style={{ width: columns.name, flexShrink: 0 }}>
                  <text style={{ wrapMode: "none", truncate: true }}>
                    {isSelected ? (
                      <b style={{ fg: THEME.selected }}>{name}</b>
                    ) : (
                      <span style={{ fg: THEME.secondary }}>{name}</span>
                    )}
                  </text>
                </box>
                <box style={{ width: COLUMN_GAP, flexShrink: 0 }} />
                <box style={{ width: columns.model, flexShrink: 0 }}>
                  <text
                    style={{
                      fg: isSelected ? THEME.secondary : THEME.muted,
                      wrapMode: "none",
                      truncate: true,
                    }}
                  >
                    {model}
                  </text>
                </box>
                <box style={{ width: COLUMN_GAP, flexShrink: 0 }} />
                <box style={{ width: columns.persona, flexShrink: 0 }}>
                  <text
                    style={{
                      fg: isSelected ? THEME.secondary : THEME.muted,
                      wrapMode: "none",
                      truncate: true,
                    }}
                  >
                    {persona}
                  </text>
                </box>
                {columns.description === 0 ? null : (
                  <>
                    <box style={{ width: COLUMN_GAP, flexShrink: 0 }} />
                    <box style={{ width: descriptionWidth, flexShrink: 0 }}>
                      <text style={{ fg: THEME.muted, wrapMode: "none", truncate: true }}>
                        {clip(description, descriptionWidth)}
                      </text>
                    </box>
                    {tag === "" ? null : (
                      <box style={{ flexGrow: 1, flexDirection: "row" }}>
                        <box style={{ flexGrow: 1 }} />
                        <text style={{ flexShrink: 0, fg: THEME.muted }}>{tag}</text>
                        <box style={{ width: RIGHT_MARGIN, flexShrink: 0 }} />
                      </box>
                    )}
                  </>
                )}
              </box>
            );
          })}
        </box>
      )}

      <box style={{ flexGrow: 1 }} />

      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <box style={{ width: GUTTER, flexShrink: 0 }} />
        <Keys
          agents={agents}
          action={action}
        />
      </box>
    </box>
  );
}
