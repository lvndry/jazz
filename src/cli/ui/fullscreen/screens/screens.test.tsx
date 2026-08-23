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
import { testRender } from "@opentui/react/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { getGlyphs } from "../../glyphs";
import { THEME } from "../../theme";
import type { Viewport } from "../types";
import { AgentPicker, agentColumns, listRowsFor, type AgentChoice } from "./AgentPicker";
import { Home, homeRows, type HomeModel } from "./Home";

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
  tagline: "your everyday agentic CLI",
  requirements: [
    { label: "agent", ready: false, detail: "none yet", remedy: "create your first one below" },
  ],
  choices: [
    { label: "Create agent", value: "create-agent", hint: "about a minute" },
    { label: "Update configuration", value: "config" },
    { label: "Exit", value: "exit" },
  ],
  selected: 0,
  tip: "Type '/help' in chat to see every command and keyboard shortcut",
};

const SETTLED: HomeModel = {
  version: "0.14.2",
  tagline: "your everyday agentic CLI",
  requirements: [{ label: "agent", ready: true, detail: "4 of them" }],
  choices: [
    { label: "Resume: Basil", value: "continue", hint: "12 minutes ago" },
    { label: "New conversation", value: "new-conversation" },
    { label: "Resume conversation", value: "resume-conversation" },
    { label: "Create agent", value: "create-agent" },
    { label: "List agents", value: "list-agents" },
    { label: "Exit", value: "exit" },
  ],
  selected: 1,
  tip: "Local models via Ollama are supported for offline privacy",
};

const AGENTS: readonly AgentChoice[] = [
  {
    id: "a1",
    name: "Basil",
    model: "claude-sonnet-4",
    description: "keeps the calendar honest",
    lastUsed: true,
  },
  { id: "a2", name: "Cass", model: "gpt-5", description: "research and long reads" },
  { id: "a3", name: "Dot", model: "gemma3:12b", description: "offline, runs on this laptop" },
  { id: "a4", name: "Fern", model: "claude-opus-4", description: "writes the hard emails" },
  { id: "a5", name: "Gus", model: "gpt-5-mini", description: "quick lookups" },
  { id: "a6", name: "Hal", model: "claude-haiku-4", description: "inbox triage" },
];

function manyAgents(count: number): readonly AgentChoice[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `id-${String(index)}`,
    name: `agent-${String(index).padStart(2, "0")}`,
    model: "claude-sonnet-4",
    description: `the number ${String(index)} agent`,
  }));
}

interface Drawn {
  readonly rows: readonly string[];
  readonly text: string;
  readonly frame: CapturedFrame;
}

async function draw(node: ReactNode, viewport: Viewport): Promise<Drawn> {
  const { renderOnce, captureCharFrame, captureSpans, renderer } = await testRender(node, {
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
  it("fills the viewport exactly, narrow and wide", async () => {
    for (const viewport of [WIDE, NARROW, HUGE]) {
      const drawn = await draw(
        <Home
          model={FIRST_RUN}
          viewport={viewport}
        />,
        viewport,
      );
      expectFillsViewport(drawn, viewport);
      expectNothingOverflows(drawn, viewport);
    }
  });

  it("uses the extra columns on a very wide terminal", async () => {
    const drawn = await draw(
      <Home
        model={FIRST_RUN}
        viewport={HUGE}
      />,
      HUGE,
    );
    expectFillsViewport(drawn, HUGE);
    expectNothingOverflows(drawn, HUGE);
    expect(drawn.rows.some((row) => row.trimEnd().length > 92)).toBe(true);
  });

  it("says what to do when nothing at all is configured", async () => {
    const drawn = await draw(
      <Home
        model={FIRST_RUN}
        viewport={WIDE}
      />,
      WIDE,
    );

    // The identity, so you know what you are looking at.
    expect(drawn.text).toContain("▄▀▀▄▀▄▄▀▀▄▄▀▄▀▀▄▀▀▄▀▄▄▀▀▄▄▀▄▀▀▄▀▀▄▀▄▄▀▀▄");
    expect(drawn.text).toContain("jazz");
    expect(drawn.text).toContain("0.14.2");
    expect(drawn.text).toContain("your everyday agentic CLI");

    // The unmet requirement, named — carrying the remedy rather than only the
    // complaint.
    expect(drawn.text).toContain("agent");
    expect(drawn.text).toContain("create your first one below");

    // And the key to press, naming the thing it is on.
    expect(drawn.text).toContain("Press enter on");
    expect(drawn.text).toContain("Create agent");
    expect(drawn.text).toContain("enter");
  });

  it("spends the accent on the remedy, not on the complaint", async () => {
    const drawn = await draw(
      <Home
        model={FIRST_RUN}
        viewport={WIDE}
      />,
      WIDE,
    );

    // The one thing on an unconfigured row that you would act on.
    const remedy = allSpans(drawn.frame).find((span) =>
      span.text.startsWith("create your first one below"),
    );
    expect(remedy).toBeDefined();
    expect(hexOf(remedy as CapturedSpan)).toBe(THEME.primary.toUpperCase());

    // A fresh install has nothing wrong with it: no amber, no red anywhere.
    for (const span of allSpans(drawn.frame)) {
      if (span.text.trim().length === 0) continue;
      expect(hexOf(span)).not.toBe(THEME.error.toUpperCase());
      expect(hexOf(span)).not.toBe(THEME.warning.toUpperCase());
    }
  });

  it("marks a met requirement with a glyph as well as a colour", async () => {
    const previous = process.env["JAZZ_UI_GLYPHS"];
    process.env["JAZZ_UI_GLYPHS"] = "unicode";
    try {
      const glyphs = getGlyphs();
      const drawn = await draw(
        <Home
          model={SETTLED}
          viewport={WIDE}
        />,
        WIDE,
      );
      const ready = drawn.rows.filter((row) => row.startsWith(glyphs.active));
      const pending = drawn.rows.filter((row) => row.startsWith(glyphs.pending));
      expect(ready).toHaveLength(1);
      expect(pending).toHaveLength(0);
      // The distinction survives a monochrome terminal.
      expect(glyphs.active).not.toBe(glyphs.pending);
      expect(hexOf(spanWithText(drawn.frame, glyphs.active))).toBe(THEME.success.toUpperCase());
    } finally {
      if (previous === undefined) delete process.env["JAZZ_UI_GLYPHS"];
      else process.env["JAZZ_UI_GLYPHS"] = previous;
    }
  });

  it("marks the selected choice by weight and a rail, never by a background", async () => {
    const drawn = await draw(
      <Home
        model={SETTLED}
        viewport={WIDE}
      />,
      WIDE,
    );

    expect(spanWithText(drawn.frame, "New conversation").attributes & TextAttributes.BOLD).not.toBe(
      0,
    );
    expect(spanWithText(drawn.frame, "Resume conversation").attributes & TextAttributes.BOLD).toBe(
      0,
    );

    const rails = allSpans(drawn.frame).filter(
      (span) => span.text === getGlyphs().rail && hexOf(span) === THEME.primary.toUpperCase(),
    );
    expect(rails).toHaveLength(1);

    // One ground for the whole screen: nothing is picked out by a wash.
    const grounds = new Set(allSpans(drawn.frame).map((span) => span.bg.toInts().join(",")));
    expect(grounds.size).toBe(1);
  });

  it("is calm enough to sit in front of", async () => {
    const previous = process.env["JAZZ_UI_GLYPHS"];
    process.env["JAZZ_UI_GLYPHS"] = "unicode";
    try {
      for (const model of [FIRST_RUN, SETTLED]) {
        const drawn = await draw(
          <Home
            model={model}
            viewport={WIDE}
          />,
          WIDE,
        );
        expect(inkDensity(drawn.rows)).toBeLessThanOrEqual(0.22);
        expect(breathingShare(drawn.rows)).toBeGreaterThanOrEqual(0.4);
      }
    } finally {
      if (previous === undefined) delete process.env["JAZZ_UI_GLYPHS"];
      else process.env["JAZZ_UI_GLYPHS"] = previous;
    }
  });

  it("gives up decoration before it gives up the menu on a short terminal", () => {
    const short: Viewport = { width: 100, height: 12 };
    const rows = homeRows(SETTLED, short);
    expect(rows.length).toBeLessThanOrEqual(short.height - 1);
    // The tip is the first thing to go; every choice is still reachable.
    const text = rows.flatMap((row) => row.segments.map((segment) => segment.text)).join(" ");
    expect(text).not.toContain("Ollama");
    expect(text).toContain("New conversation");
  });

  it("keeps the selection on screen when the menu is longer than the space left", () => {
    const short: Viewport = { width: 100, height: 12 };
    const long: HomeModel = {
      ...SETTLED,
      choices: Array.from({ length: 20 }, (_unused, index) => ({
        label: `Option ${String(index)}`,
        value: `option-${String(index)}`,
      })),
      selected: 17,
    };
    const rows = homeRows(long, short);
    const text = rows.flatMap((row) => row.segments.map((segment) => segment.text)).join(" ");
    expect(text).toContain("Option 17");
    expect(rows.length).toBeLessThanOrEqual(short.height - 1);
  });

  it("draws nothing outside the ranges the target fonts cover", async () => {
    const previous = process.env["JAZZ_UI_GLYPHS"];
    for (const mode of ["unicode", "ascii"]) {
      process.env["JAZZ_UI_GLYPHS"] = mode;
      try {
        for (const model of [FIRST_RUN, SETTLED]) {
          const drawn = await draw(
            <Home
              model={model}
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

describe("both screens in ascii glyph mode", () => {
  const previous = process.env["JAZZ_UI_GLYPHS"];

  beforeAll(() => {
    process.env["JAZZ_UI_GLYPHS"] = "ascii";
  });

  afterAll(() => {
    if (previous === undefined) delete process.env["JAZZ_UI_GLYPHS"];
    else process.env["JAZZ_UI_GLYPHS"] = previous;
  });

  it("still marks identity, readiness and selection with ASCII alone", async () => {
    const glyphs = getGlyphs();
    const home = await draw(
      <Home
        model={SETTLED}
        viewport={WIDE}
      />,
      WIDE,
    );
    expect(home.text).toContain(`${glyphs.note}  jazz`);
    // ASCII spends `*` on the mark, the ready state and the bullet, so readiness
    // is asserted from the side that stays unambiguous: what is NOT ready.
    expect(glyphs.active).not.toBe(glyphs.pending);
    const firstRun = await draw(
      <Home
        model={FIRST_RUN}
        viewport={WIDE}
      />,
      WIDE,
    );
    expect(firstRun.rows.filter((row) => row.startsWith(glyphs.pending))).toHaveLength(1);
    expect(home.rows.filter((row) => row.startsWith(glyphs.rail))).toHaveLength(1);

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
