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
import { HOME_COMMANDS, type HomeState } from "../../models/home-view";
import { THEME } from "../../theme";
import { renderForTest } from "../test-helpers";
import type { Viewport } from "../types";

const WIDE: Viewport = { width: 100, height: 28 };
const NARROW: Viewport = { width: 60, height: 20 };
const HUGE: Viewport = { width: 200, height: 40 };
const TALL: Viewport = { width: 100, height: 40 };

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
  shownAt: 1,
  agents: [],
  agentCount: 0,
  waiting: [],
  commands: HOME_COMMANDS,
  firstRun: {
    actions: [
      { label: "Start setup", value: "create-agent" },
      { label: "Use Ollama, no key needed", value: "create-agent:ollama" },
      { label: "Settings", value: "settings" },
    ],
    detected: [
      { label: "OPENAI_API_KEY", detail: "in your environment" },
      { label: "Ollama", detail: "running on this machine with 3 models" },
    ],
  },
};

const SETTLED: HomeModel = {
  version: "0.14.2",
  shownAt: 1,
  agents: [
    { id: "sol", name: "sol", model: "gpt-5.6-sol", persona: "default", lastUsed: "1m ago" },
    { id: "luna", name: "luna", model: "gpt-5.6-luna", persona: "default", lastUsed: "2h ago" },
    {
      id: "long",
      name: "lysk-server-vllm-agent",
      model: "qwen3.8-27b-instruct-awq-long",
      persona: "coder",
      lastUsed: "1d ago",
    },
  ],
  agentCount: 31,
  targetAgentId: "sol",
  waiting: [
    {
      key: "1",
      value: "open:luna:c1",
      title: "Wedding venue",
      agent: "luna",
      reason: "question",
      age: "1d ago",
      detail: "Which venue should I confirm with Dana?",
    },
    {
      key: "2",
      value: "open:sol:c2",
      title: "Organize Downloads",
      agent: "sol",
      reason: "review",
      age: "1d ago",
      detail: "Found 214 old exports. Delete them, or keep the newest 20?",
    },
  ],
  commands: HOME_COMMANDS,
  warning: { text: "no model provider has a key", fix: "/settings" },
};

function homeState(patch: Partial<HomeState> = {}): HomeState {
  return { agentId: "sol", waitingValue: undefined, draft: "", commandIndex: 0, ...patch };
}

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
  function drawHome(
    model: HomeModel,
    viewport: Viewport,
    patch: Partial<HomeState> = {},
  ): Promise<Drawn> {
    const state = homeState(patch);
    return draw(
      <Home
        model={model}
        viewport={viewport}
        state={state}
        caret={[...state.draft].length}
      />,
      viewport,
    );
  }

  it("leads with a filled New conversation button that names its agent", async () => {
    const drawn = await drawHome(SETTLED, TALL);
    const button = drawn.rows.findIndex((row) => row.includes("+ New conversation"));
    const composer = drawn.rows.findIndex((row) =>
      row.includes("Type / to get started, or type your first message"),
    );
    const agents = drawn.rows.findIndex((row) => row.includes("Start with another agent"));
    expect(button).toBeGreaterThan(-1);
    expect(button).toBeLessThan(composer);
    expect(composer).toBeLessThan(agents);
    expect(drawn.rows[button]).toContain("with sol  gpt-5.6-sol");
    expect(drawn.rows[composer]).toContain("enter sends to sol");
    const fill = spanWithText(drawn.frame, " + New conversation ");
    expect(fill.attributes & TextAttributes.BOLD).toBeTruthy();
    const [red, green, blue] = fill.bg.toInts();
    expect(
      [red, green, blue].reduce((hex, channel) => hex + channel.toString(16).padStart(2, "0"), "#"),
    ).toBe(THEME.primary.toLowerCase());
  });

  it("re-targets the button and the composer when another agent is chosen", async () => {
    const drawn = await drawHome(SETTLED, TALL, { agentId: "luna" });
    expect(drawn.text).toContain("with luna  gpt-5.6-luna");
    expect(drawn.text).toContain("enter sends to luna");
    const chosen = drawn.rows.find((row) => row.includes("› luna"));
    expect(chosen).toBeDefined();
  });

  it("sets agents as a table and cuts a long value to its column", async () => {
    const drawn = await drawHome(SETTLED, TALL);
    const rows = drawn.rows.filter((row) => /default|coder/.test(row));
    const modelColumn = rows.map((row) => row.search(/gpt-5\.6|qwen3/));
    expect(new Set(modelColumn).size).toBe(1);
    const long = rows.find((row) => row.includes("lysk"));
    expect(long).toMatch(/lysk\S*…\s{2,}qwen/);
  });

  it("shows waiting conversations by title with what they need", async () => {
    const drawn = await drawHome(SETTLED, TALL);
    expect(drawn.text).toContain("Waiting for you");
    const venue = drawn.rows.find((row) => row.includes("Wedding venue")) ?? "";
    expect(venue).toContain("asked 1d ago");
    expect(drawn.text).toContain("Which venue should I confirm with Dana?");
    expect(drawn.text).toContain("needs review · 1d");
    expect(drawn.text).not.toContain("untitled");
  });

  it("drops the waiting section when nothing waits", async () => {
    const drawn = await drawHome({ ...SETTLED, waiting: [] }, TALL);
    expect(drawn.text).not.toContain("Waiting for you");
  });

  it("puts the hints in the footer with the warning on the right, and no path", async () => {
    const drawn = await drawHome(SETTLED, TALL);
    const footer = drawn.rows.at(-1) ?? "";
    expect(footer).toContain("/ commands   ↓ waiting   tab all agents   esc quit");
    expect(footer.trimEnd().endsWith("no model provider has a key  /settings")).toBe(true);
    expect(drawn.text).not.toContain("~/");
    expect(drawn.text).not.toContain("n new agent");
  });

  it("moves the selection into waiting and says enter opens it", async () => {
    const drawn = await drawHome(SETTLED, TALL, { waitingValue: "open:sol:c2" });
    expect(drawn.rows.find((row) => row.includes("› Organize Downloads"))).toBeDefined();
    expect(drawn.rows.some((row) => row.includes("› sol"))).toBe(false);
    expect(drawn.text).toContain("enter opens Organize Downloads");
    const button = spanWithText(drawn.frame, " + New conversation ");
    expect(button.attributes & TextAttributes.BOLD).toBeFalsy();
  });

  it("shows the command menu under the composer with matched letters bold", async () => {
    const drawn = await drawHome(SETTLED, TALL, { draft: "/re" });
    const descriptions = HOME_COMMANDS.map((command) => command.description);
    const menu = drawn.rows.filter((row) => descriptions.some((text) => row.includes(text)));
    expect(menu).toHaveLength(2);
    expect(menu[0]).toContain("/resume");
    expect(menu[1]).toContain("/create");
    expect(drawn.text).toContain("enter runs /resume");
    const matched = allSpans(drawn.frame).filter((span) => span.text === "re");
    expect(matched.some((span) => (span.attributes & TextAttributes.BOLD) !== 0)).toBe(true);
  });

  it("draws the caret before the placeholder, never over its first letter", async () => {
    const drawn = await drawHome(SETTLED, TALL);
    const composer = drawn.rows.find((row) => row.includes("type your first message")) ?? "";
    expect(composer).toContain(" Type / to get started, or type your first message");
  });

  it("anchors the block near the top and keeps the chosen agent on a short terminal", () => {
    const tall = homeRows(SETTLED, TALL, homeState());
    const firstInk = tall.findIndex((row) => row.kind === "composer" || row.segments.length > 0);
    expect(firstInk).toBeLessThanOrEqual(3);
    const short: Viewport = { width: 100, height: 14 };
    const rows = homeRows(SETTLED, short, homeState({ agentId: "long" }));
    const text = rows
      .map((row) =>
        row.kind === "composer" ? "composer" : row.segments.map((part) => part.text).join(""),
      )
      .join("\n");
    expect(rows.length).toBeLessThanOrEqual(short.height - 1);
    expect(text).toContain("+ New conversation");
    expect(text).toContain("composer");
    expect(text).toContain("lysk");
  });

  it("introduces jazz on first run and names what it found", async () => {
    const drawn = await drawHome(FIRST_RUN, TALL, { agentId: undefined });
    expect(drawn.text).toContain("One agent for your email, calendar, files and the web.");
    expect(drawn.text).toContain("Found OPENAI_API_KEY in your environment");
    expect(drawn.rows.find((row) => row.includes("› Start setup"))).toContain("enter");
    expect(drawn.text).toContain("Use Ollama, no key needed");
    expect(drawn.text).not.toContain("New conversation");
  });

  it("keeps a right margin at any width", async () => {
    const drawn = await drawHome(SETTLED, HUGE);
    expectNothingOverflows(drawn, HUGE);
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

  it("still marks identity, the waiting bar and selection with ASCII alone", async () => {
    const glyphs = getGlyphs();
    const home = await draw(
      <Home
        model={SETTLED}
        viewport={TALL}
        state={homeState()}
        caret={0}
      />,
      TALL,
    );
    expect(home.text).toContain(`${glyphs.note} jazz`);
    expect(home.rows.some((row) => row.startsWith(glyphs.bandBar))).toBe(true);
    expect(home.rows.some((row) => row.includes("› sol"))).toBe(true);

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
