/** @jsxImportSource @opentui/react */

/**
 * The two screens that stand between `jazz` and a chat session.
 *
 * Both are pure functions of their props, so these assertions are about
 * characters and attributes rather than about a React tree: which sentence a
 * new user reads when nothing is configured, whether the selected row is bold,
 * whether anything painted a background, whether a 200-column terminal
 * still keeps a right margin.
 *
 * `captureSpans()` carries the real per-span colour, which most of this repo's
 * suite cannot see — it runs with colour disabled. So the colour law is
 * enforced here or nowhere.
 */

import { TextAttributes, type CapturedFrame, type CapturedSpan } from "@opentui/core";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { AgentDetails } from "./AgentDetails";
import {
  AgentPicker,
  agentColumns,
  filterAgents,
  listRowsFor,
  type AgentChoice,
} from "./AgentPicker";
import { Home, homeRows, type HomeModel } from "./Home";
import { getGlyphs } from "../../glyphs";
import { agentDetailsRows } from "../../models/agent-details";
import { THEME } from "../../theme";
import { renderForTest } from "../test-helpers";
import type { Viewport } from "../types";

const WIDE: Viewport = { width: 100, height: 28 };
const NARROW: Viewport = { width: 60, height: 20 };
const HUGE: Viewport = { width: 200, height: 40 };

/**
 * Verified-safe ranges: ASCII, Latin-1, General Punctuation, Math Operators,
 * Box Drawing and Block Elements. Everything else risks a fallback glyph at a
 * mismatched advance width — see the coverage tables in `glyphs.ts`.
 */
function safeCharacter(codePoint: number): boolean {
  return (
    (codePoint >= 0x20 && codePoint <= 0x7e) ||
    (codePoint >= 0xa0 && codePoint <= 0xff) ||
    (codePoint >= 0x2000 && codePoint <= 0x206f) ||
    (codePoint >= 0x2200 && codePoint <= 0x22ff) ||
    (codePoint >= 0x2500 && codePoint <= 0x259f)
  );
}

const FIRST_RUN: HomeModel = {
  version: "0.14.2",
  cwd: "~/work",
  greeting: "",
  conversations: [],
  actions: [
    { key: "enter", label: "start setup", value: "create-agent" },
    { key: "o", label: "use Ollama, no key needed", value: "create-agent:ollama" },
    { key: "s", label: "settings", value: "config" },
    { key: "q", label: "quit", value: "exit" },
  ],
  status: [],
  firstRun: {
    detected: [
      { label: "OPENAI_API_KEY", detail: "in your environment" },
      { label: "Ollama", detail: "running on this machine with 3 models" },
    ],
  },
};

const SETTLED: HomeModel = {
  version: "0.14.2",
  cwd: "~/work",
  greeting: "Good morning.",
  conversations: [
    {
      key: "1",
      value: "open:a1:c1",
      title: "Wedding planning",
      agent: "Basil",
      detail: "goal venue waiting for your answer",
      age: "9m ago",
      waiting: true,
    },
    {
      key: "2",
      value: "open:a2:c2",
      title: "Weekly review",
      agent: "Cass",
      detail: "14 messages",
      age: "1d ago",
      waiting: false,
    },
  ],
  actions: [
    { key: "enter", label: "new conversation with Basil", value: "new-conversation" },
    { key: "a", label: "another agent", value: "pick-agent" },
    { key: "n", label: "new agent", value: "create-agent" },
    { key: "r", label: "resume", value: "resume-conversation" },
    { key: "l", label: "agents", value: "list-agents" },
    { key: "s", label: "settings", value: "config" },
    { key: "q", label: "quit", value: "exit" },
  ],
  status: [
    { text: "4 agents" },
    { text: "no model provider has a key", tone: "warning", fixKey: "s" },
  ],
};

const AGENTS: readonly AgentChoice[] = [
  {
    id: "a1",
    name: "Basil",
    model: "claude-sonnet-4",
    persona: "assistant",
    description: "keeps the calendar honest",
    lastUsed: true,
  },
  {
    id: "a2",
    name: "Cass",
    model: "gpt-5",
    persona: "researcher",
    description: "research and long reads",
  },
  {
    id: "a3",
    name: "Dot",
    model: "gemma3:12b",
    persona: "assistant",
    description: "offline, runs on this laptop",
  },
  {
    id: "a4",
    name: "Fern",
    model: "claude-opus-4",
    persona: "writer",
    description: "writes the hard emails",
  },
  {
    id: "a5",
    name: "Gus",
    model: "gpt-5-mini",
    persona: "assistant",
    description: "quick lookups",
  },
  {
    id: "a6",
    name: "Hal",
    model: "claude-haiku-4",
    persona: "assistant",
    description: "inbox triage",
  },
];

function manyAgents(count: number): readonly AgentChoice[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `id-${String(index)}`,
    name: `agent-${String(index).padStart(2, "0")}`,
    model: "claude-sonnet-4",
    persona: "assistant",
    description: `the number ${String(index)} agent`,
  }));
}

interface Drawn {
  readonly rows: readonly string[];
  readonly text: string;
  readonly frame: CapturedFrame;
}

async function draw(node: ReactNode, viewport: Viewport): Promise<Drawn> {
  const { renderOnce, captureCharFrame, captureSpans, renderer } = await renderForTest(node, {
    width: viewport.width,
    height: viewport.height,
  });
  await renderOnce();
  const text = captureCharFrame();
  const frame = captureSpans();
  renderer.destroy();
  return { rows: text.split("\n").filter((row) => row.length > 0), text, frame };
}

function allSpans(frame: CapturedFrame): CapturedSpan[] {
  return frame.lines.flatMap((line) => line.spans);
}

function hexOf(span: CapturedSpan): string {
  const [red, green, blue] = span.fg.toInts();
  return [red, green, blue]
    .reduce((hex, channel) => hex + channel.toString(16).padStart(2, "0"), "#")
    .toUpperCase();
}

function spanWithText(frame: CapturedFrame, text: string): CapturedSpan {
  const found = allSpans(frame).find((span) => span.text === text);
  if (found === undefined) throw new Error(`no span with exact text ${JSON.stringify(text)}`);
  return found;
}

/** Cells that carry content rather than space or structural chrome. */
function chrome(): Set<string> {
  const glyphs = getGlyphs();
  return new Set([
    glyphs.rail,
    glyphs.railDeep,
    glyphs.divider,
    glyphs.note,
    glyphs.active,
    glyphs.pending,
    glyphs.bullet,
    glyphs.gridFilled,
    glyphs.gridEmpty,
  ]);
}

function inkDensity(rows: readonly string[]): number {
  const marks = chrome();
  const cells = rows.flatMap((row) => [...row]);
  const ink = cells.filter((cell) => cell.trim().length > 0 && !marks.has(cell)).length;
  return ink / Math.max(1, cells.length);
}

function breathingShare(rows: readonly string[]): number {
  const marks = chrome();
  const quiet = rows.filter((row) => {
    const inked = [...row].filter((cell) => cell.trim().length > 0);
    return inked.length === 0 || inked.every((cell) => marks.has(cell));
  }).length;
  return quiet / Math.max(1, rows.length);
}

function expectFillsViewport(drawn: Drawn, viewport: Viewport): void {
  expect(drawn.rows).toHaveLength(viewport.height);
  for (const row of drawn.rows) expect([...row]).toHaveLength(viewport.width);
}

/** No row may end in the last column: the page keeps a right margin at every width. */
function expectNothingOverflows(drawn: Drawn, viewport: Viewport): void {
  for (const row of drawn.rows) {
    expect(row.trimEnd().length).toBeLessThanOrEqual(viewport.width - 1);
  }
}

describe("home screen", () => {
  it("leads with what is waiting for you, ahead of what you were last in", async () => {
    const drawn = await draw(
      <Home
        model={SETTLED}
        viewport={WIDE}
      />,
      WIDE,
    );
    const waiting = drawn.rows.findIndex((row) => row.includes("Wedding planning"));
    const recent = drawn.rows.findIndex((row) => row.includes("Weekly review"));
    const actions = drawn.rows.findIndex((row) => row.includes("new conversation with Basil"));
    expect(waiting).toBeGreaterThan(-1);
    expect(waiting).toBeLessThan(recent);
    expect(recent).toBeLessThan(actions);
    expect(drawn.text).toContain("1 conversation is waiting for you.");
    expect(drawn.text).toContain("waiting · 9m ago");
    expect(drawn.text).toContain("goal venue waiting for your answer");
  });

  it("marks the waiting conversation with the accent bar and leaves the other unbarred", async () => {
    const glyphs = getGlyphs();
    const drawn = await draw(
      <Home
        model={SETTLED}
        viewport={WIDE}
      />,
      WIDE,
    );
    const barred = drawn.rows.filter((row) => row.startsWith(glyphs.bandBar));
    expect(barred).toHaveLength(2);
    expect(barred.every((row) => !row.includes("Weekly review"))).toBe(true);
    expect(hexOf(spanWithText(drawn.frame, glyphs.bandBar))).toBe(THEME.primary.toUpperCase());
  });

  it("offers every action as a single key, with the number keys for conversations", async () => {
    const drawn = await draw(
      <Home
        model={SETTLED}
        viewport={WIDE}
      />,
      WIDE,
    );
    expect(drawn.text).toContain("enter new conversation with Basil");
    expect(drawn.text).toContain("1–2 open one");
    for (const label of ["a another agent", "n new agent", "r resume", "s settings", "q quit"]) {
      expect(drawn.text).toContain(label);
    }
    expect(spanWithText(drawn.frame, "enter").attributes & TextAttributes.BOLD).toBeTruthy();
  });

  it("says how the setup stands on one line, with the fix key beside a warning", async () => {
    const drawn = await draw(
      <Home
        model={SETTLED}
        viewport={WIDE}
      />,
      WIDE,
    );
    const status = drawn.rows.filter((row) => row.includes("4 agents"));
    expect(status).toHaveLength(1);
    expect(status[0]).toContain("no model provider has a key  s");
    expect(hexOf(spanWithText(drawn.frame, "no model provider has a key"))).toBe(
      THEME.warning.toUpperCase(),
    );
  });

  it("carries no tagline, environment report or CRUD menu", async () => {
    const drawn = await draw(
      <Home
        model={SETTLED}
        viewport={WIDE}
      />,
      WIDE,
    );
    for (const gone of [
      "what would you like to do?",
      "Edit agent",
      "Delete agent",
      "darwin",
      "setup",
    ]) {
      expect(drawn.text).not.toContain(gone);
    }
    expect(drawn.rows.at(-1)).toContain("jazz 0.14.2");
    expect(drawn.rows.at(-1)).toContain("~/work");
  });

  it("gives up the status line, then conversations, before it gives up an action", () => {
    const short: Viewport = { width: 100, height: 11 };
    const rows = homeRows(SETTLED, short);
    const text = rows.map((row) => row.segments.map((segment) => segment.text).join("")).join("\n");
    expect(rows.length).toBeLessThanOrEqual(short.height - 1);
    expect(text).not.toContain("4 agents");
    expect(text).toContain("q quit");
    expect(text).toContain("new conversation with Basil");
  });

  it("introduces jazz on first run and names what it already found", async () => {
    const drawn = await draw(
      <Home
        model={FIRST_RUN}
        viewport={WIDE}
      />,
      WIDE,
    );
    expect(drawn.text).toContain("One agent for your email, calendar, files and the web.");
    expect(drawn.text).toContain("1 pick a model");
    expect(drawn.text).toContain("3 say hello");
    expect(drawn.text).toContain("Found OPENAI_API_KEY in your environment");
    expect(drawn.text).toContain("and Ollama running on this machine with 3 models");
    expect(drawn.text).toContain("enter start setup");
    expect(drawn.text).toContain("o use Ollama, no key needed");
  });

  it("keeps a right margin and never paints outside its bands", async () => {
    const drawn = await draw(
      <Home
        model={SETTLED}
        viewport={HUGE}
      />,
      HUGE,
    );
    expectNothingOverflows(drawn, HUGE);
    expect(inkDensity(drawn.rows)).toBeLessThan(0.2);
    expect(breathingShare(drawn.rows)).toBeGreaterThan(0.4);
  });
});

describe("agent picker", () => {
  it("fills the viewport exactly at every supported width", async () => {
    for (const viewport of [WIDE, NARROW, HUGE]) {
      const drawn = await draw(
        <AgentPicker
          agents={AGENTS}
          selectedIndex={2}
          viewport={viewport}
        />,
        viewport,
      );
      expectFillsViewport(drawn, viewport);
      expectNothingOverflows(drawn, viewport);
    }
  });

  it("shows the name, the model and enough to tell two agents apart", async () => {
    const drawn = await draw(
      <AgentPicker
        agents={AGENTS}
        selectedIndex={0}
        viewport={WIDE}
      />,
      WIDE,
    );
    expect(drawn.text).toContain("Basil");
    expect(drawn.text).toContain("claude-sonnet-4");
    expect(drawn.text).toContain("keeps the calendar honest");
    expect(drawn.text).toContain("last used");
    expect(drawn.text).toContain("1 of 6");
    expect(drawn.text).toContain("enter");
  });

  it("marks the selected agent by weight and a rail, never by a background", async () => {
    const drawn = await draw(
      <AgentPicker
        agents={AGENTS}
        selectedIndex={3}
        viewport={WIDE}
      />,
      WIDE,
    );

    expect(spanWithText(drawn.frame, "Fern").attributes & TextAttributes.BOLD).not.toBe(0);
    expect(spanWithText(drawn.frame, "Basil").attributes & TextAttributes.BOLD).toBe(0);
    expect(hexOf(spanWithText(drawn.frame, "Fern"))).toBe(THEME.selected.toUpperCase());

    const rails = allSpans(drawn.frame).filter(
      (span) => span.text === getGlyphs().rail && hexOf(span) === THEME.primary.toUpperCase(),
    );
    expect(rails).toHaveLength(1);

    const grounds = new Set(allSpans(drawn.frame).map((span) => span.bg.toInts().join(",")));
    expect(grounds.size).toBe(1);
  });

  it("ranks name prefix, then name substring, then model or persona, then letters in order", () => {
    const names = (query: string) => filterAgents(AGENTS, query).map((match) => match.agent.name);
    expect(names("")).toEqual(AGENTS.map((agent) => agent.name));
    expect(names("fe")).toEqual(["Fern"]);
    expect(names("opus")).toEqual(["Fern"]);
    expect(names("writer")).toEqual(["Fern"]);
    expect(names("bsl")).toEqual(["Basil"]);
    expect(names("zzz")).toEqual([]);
    expect(filterAgents(AGENTS, "as")[0]?.nameHits).toEqual([1, 2]);
  });

  it("filters to what was typed, counts the matches, and sets the hit in weight", async () => {
    const drawn = await draw(
      <AgentPicker
        agents={AGENTS}
        selectedIndex={0}
        viewport={WIDE}
        query="fe"
      />,
      WIDE,
    );
    expect(drawn.text).toContain("fe");
    expect(drawn.text).toContain("Fern");
    expect(drawn.text).not.toContain("Basil");
    expect(drawn.text).toContain("1 match");
    expect(spanWithText(drawn.frame, "Fe").attributes & TextAttributes.BOLD).not.toBe(0);

    const none = await draw(
      <AgentPicker
        agents={AGENTS}
        selectedIndex={0}
        viewport={WIDE}
        query="zzz"
      />,
      WIDE,
    );
    expect(none.text).toContain("no matches");
    expect(none.text).toContain('No agent matches "zzz".');
  });

  it("handles no agents by saying what to do instead", async () => {
    const drawn = await draw(
      <AgentPicker
        agents={[]}
        selectedIndex={0}
        viewport={WIDE}
      />,
      WIDE,
    );
    expectFillsViewport(drawn, WIDE);
    expect(drawn.text).toContain("No agents yet.");
    expect(drawn.text).toContain("Create agent");
    expect(drawn.text).toContain("no agents");
    expect(drawn.text).toContain("esc");
    // Nothing to move through, so nothing claims there is.
    expect(drawn.text).not.toContain("move");
  });

  it("handles a single agent without pretending there is a list", async () => {
    const one = AGENTS.slice(0, 1);
    const drawn = await draw(
      <AgentPicker
        agents={one}
        selectedIndex={0}
        viewport={WIDE}
      />,
      WIDE,
    );
    expect(drawn.text).toContain("1 agent");
    expect(drawn.text).toContain("Basil");
    expectFillsViewport(drawn, WIDE);
  });

  it("keeps the selection visible when there are more agents than rows", async () => {
    const agents = manyAgents(40);
    expect(agents.length).toBeGreaterThan(listRowsFor(NARROW));

    const deep = await draw(
      <AgentPicker
        agents={agents}
        selectedIndex={37}
        viewport={NARROW}
      />,
      NARROW,
    );
    expect(deep.text).toContain("agent-37");
    expect(deep.text).toContain("38 of 40");
    const railRows = deep.rows.filter((row) => row.startsWith(getGlyphs().rail));
    expect(railRows).toHaveLength(1);
    expect(railRows[0]).toContain("agent-37");
    expectFillsViewport(deep, NARROW);

    const top = await draw(
      <AgentPicker
        agents={agents}
        selectedIndex={0}
        viewport={NARROW}
      />,
      NARROW,
    );
    expect(top.text).toContain("agent-00");
    expect(top.text).not.toContain("agent-37");
  });

  it("lists every agent by name and model when opened to browse", async () => {
    const drawn = await draw(
      <AgentPicker
        agents={AGENTS}
        selectedIndex={0}
        viewport={WIDE}
        title="agents"
        action="back"
      />,
      WIDE,
    );
    expect(drawn.text).toContain("agents");
    expect(drawn.text).toContain("Basil");
    expect(drawn.text).toContain("Cass");
    expect(drawn.text).toContain("claude-sonnet-4");
    expect(drawn.text).toContain("gpt-5");
    expect(drawn.text).toContain("enter back");
    expect(drawn.text).not.toContain("No agents yet.");
    expect(drawn.text).not.toContain("enter start");
  });

  it("says what the list is for, so edit and delete cannot look like start", async () => {
    const drawn = await draw(
      <AgentPicker
        agents={AGENTS}
        selectedIndex={0}
        viewport={WIDE}
        title="delete an agent"
        action="delete"
      />,
      WIDE,
    );
    expect(drawn.text).toContain("delete an agent");
    expect(drawn.text).toContain("enter delete");
    expect(drawn.text).not.toContain("enter start");
  });

  it("drops the description column whole rather than truncating it into noise", () => {
    const wide = agentColumns(AGENTS, 88);
    expect(wide.description).toBeGreaterThanOrEqual(12);

    const squeezed = agentColumns(AGENTS, 30);
    expect(squeezed.description).toBe(0);
    // Name and model keep their readable minimums instead.
    expect(squeezed.name).toBeGreaterThanOrEqual(10);
    expect(squeezed.model).toBeGreaterThanOrEqual(8);
  });

  it("is calm enough to scan", async () => {
    const previous = process.env["JAZZ_UI_GLYPHS"];
    process.env["JAZZ_UI_GLYPHS"] = "unicode";
    try {
      // Measured on a realistic list. A window packed with forty rows of data is
      // dense by definition; the design claim is that the ordinary case breathes.
      const drawn = await draw(
        <AgentPicker
          agents={AGENTS}
          selectedIndex={0}
          viewport={WIDE}
        />,
        WIDE,
      );
      expect(inkDensity(drawn.rows)).toBeLessThanOrEqual(0.22);
      expect(breathingShare(drawn.rows)).toBeGreaterThanOrEqual(0.4);
    } finally {
      if (previous === undefined) delete process.env["JAZZ_UI_GLYPHS"];
      else process.env["JAZZ_UI_GLYPHS"] = previous;
    }
  });

  it("draws nothing outside the ranges the target fonts cover", async () => {
    const previous = process.env["JAZZ_UI_GLYPHS"];
    for (const mode of ["unicode", "ascii"]) {
      process.env["JAZZ_UI_GLYPHS"] = mode;
      try {
        for (const agents of [AGENTS, [], manyAgents(40)]) {
          const drawn = await draw(
            <AgentPicker
              agents={agents}
              selectedIndex={1}
              viewport={WIDE}
            />,
            WIDE,
          );
          const offenders = [...new Set([...drawn.text])]
            .filter((character) => character !== "\n")
            .filter((character) => !safeCharacter(character.codePointAt(0) ?? 0));
          expect(offenders).toEqual([]);
        }
      } finally {
        if (previous === undefined) delete process.env["JAZZ_UI_GLYPHS"];
        else process.env["JAZZ_UI_GLYPHS"] = previous;
      }
    }
  });
});

describe("agent details", () => {
  it("wraps long fields and fills narrow and wide viewports", async () => {
    const fields = [
      { section: "Model", label: "Provider", value: "vllm" },
      {
        section: "Model",
        label: "Host URL",
        value: "https://gpu.example:8000/v1/really/long/path/to/models",
      },
    ];
    expect(agentDetailsRows(fields, 32).length).toBeGreaterThan(fields.length + 1);
    for (const viewport of [NARROW, WIDE]) {
      const drawn = await draw(
        <AgentDetails
          kind="agent-details"
          name="Research"
          fields={fields}
          offset={0}
          viewport={viewport}
        />,
        viewport,
      );
      expectFillsViewport(drawn, viewport);
      expectNothingOverflows(drawn, viewport);
      expect(drawn.text).toContain("Host URL");
    }
  });
});

describe("both screens in ascii glyph mode", () => {
  const previous = process.env["JAZZ_UI_GLYPHS"];

  beforeAll(() => {
    process.env["JAZZ_UI_GLYPHS"] = "ascii";
  });

  afterAll(() => {
    if (previous === undefined) delete process.env["JAZZ_UI_GLYPHS"];
    else process.env["JAZZ_UI_GLYPHS"] = previous;
  });

  it("still marks identity, waiting conversations and selection with ASCII alone", async () => {
    const glyphs = getGlyphs();
    const home = await draw(
      <Home
        model={SETTLED}
        viewport={WIDE}
      />,
      WIDE,
    );
    expect(home.text).toContain(`${glyphs.note} jazz`);
    expect(home.rows.filter((row) => row.startsWith(glyphs.bandBar))).toHaveLength(2);

    const picker = await draw(
      <AgentPicker
        agents={AGENTS}
        selectedIndex={1}
        viewport={WIDE}
      />,
      WIDE,
    );
    expect(picker.rows.filter((row) => row.startsWith(glyphs.rail))).toHaveLength(1);
    expectFillsViewport(picker, WIDE);
  });
});
