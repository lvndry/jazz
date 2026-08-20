/** @jsxImportSource @opentui/react */

/**
 * The transcript's contract, measured rather than described.
 *
 * The load-bearing test is the density one. An earlier draft of this layout was
 * measured at 32% ink and rejected as "very busy", so the design was given a
 * number to hit: ≤22% ink and ≥40% breathing rows on a realistic session. Every
 * other assertion here protects a rule that keeps that number honest — the
 * measure, the right margin, receipts without durations, chrome on the neutral
 * ramp — and one of them reads the real RGB out of the frame, which the rest of
 * this repo's suite (colour off) cannot do.
 */

import type { CapturedSpan } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { beforeAll, describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { getGlyphs } from "../glyphs";
import { setThemeVariant, THEME } from "../theme";
import { Transcript, transcriptRows } from "./Transcript";
import { PROSE_MEASURE, type Block, type Viewport } from "./types";

beforeAll(() => {
  process.env["JAZZ_UI_GLYPHS"] = "unicode";
  setThemeVariant("dark");
});

const WIDE: Viewport = { width: 120, height: 34 };
const NARROW: Viewport = { width: 80, height: 34 };

/**
 * A realistic session: one question, a collapsed reasoning line, four settled
 * tool calls plus one failure, an expanded entity list, a delegated lane, and an
 * answer with a table. This is the scene the density budget is spent on.
 */
const SESSION: readonly Block[] = [
  {
    id: "u1",
    seq: 1,
    kind: "user",
    text: "what did I miss in my inbox this week? anything urgent should go on my calendar",
    at: "14:32",
  },
  { id: "r1", seq: 2, kind: "reasoning", collapsed: true, text: "", steps: 8, durationMs: 3_200 },
  {
    id: "t1",
    seq: 3,
    kind: "tool",
    app: "gmail",
    summary: "4 flagged of 26",
    status: "ok",
    durationMs: 1_900,
  },
  {
    id: "t2",
    seq: 4,
    kind: "tool",
    app: "web",
    summary: "3 sources",
    status: "ok",
    durationMs: 2_400,
  },
  {
    id: "t3",
    seq: 5,
    kind: "tool",
    app: "calendar",
    summary: "2 conflicts",
    status: "ok",
    durationMs: 600,
  },
  {
    id: "t4",
    seq: 6,
    kind: "tool",
    app: "files",
    summary: "3 notes",
    status: "ok",
    durationMs: 120,
    expanded: true,
    detail: [
      "inbox.md          2.1 kB",
      "contracts.md      8.4 kB",
      "travel.md         1.2 kB",
    ].join("\n"),
  },
  {
    id: "t5",
    seq: 7,
    kind: "tool",
    app: "slack",
    summary: "could not read",
    status: "failed",
    reason: "read-only connection",
    remedyKey: "ctrl+a reconnects",
    durationMs: 400,
  },
  {
    id: "l1",
    seq: 8,
    kind: "lane",
    name: "travel-scout",
    ask: "check whether the Basel dates moved",
    lane: 1,
    state: "done",
    result: "venue page says 12-13 March, unchanged",
    steps: 9,
  },
  {
    id: "a1",
    seq: 9,
    kind: "agent",
    markdown: [
      "Four things need you this week. Two are quick replies, one is a contract question, and one is a",
      "scheduling conflict I can hold a slot for.",
      "",
      "| From | Subject | Action |",
      "| --- | --- | --- |",
      "| Dana Okafor | Q3 board deck | numbers Thursday |",
      "| M. Ricci | contract redlines | two open items |",
      "| City Clinic | appointment moved | confirm or rebook |",
      "",
      "- The Basel dates did not move, so your flights still hold ‹1›.",
    ].join("\n"),
  },
];

interface Rendered {
  readonly rows: readonly string[];
  readonly spans: readonly CapturedSpan[];
}

async function render(node: ReactNode, viewport: Viewport): Promise<Rendered> {
  const { renderOnce, captureCharFrame, captureSpans, renderer } = await testRender(node, {
    width: viewport.width,
    height: viewport.height,
  });
  await renderOnce();
  const rows = captureCharFrame()
    .split("\n")
    .filter((line) => line.length > 0);
  const spans = captureSpans().lines.flatMap((line) => line.spans);
  renderer.destroy();
  return { rows, spans };
}

function transcript(blocks: readonly Block[], viewport: Viewport, newBelow?: number): ReactNode {
  return (
    <box style={{ width: viewport.width, height: viewport.height, flexDirection: "column" }}>
      <Transcript
        blocks={blocks}
        viewport={viewport}
        focus="input"
        {...(newBelow === undefined ? {} : { newBelow })}
      />
    </box>
  );
}

/** The captured colour of the first span whose text contains `needle`. */
function colorOf(spans: readonly CapturedSpan[], needle: string): string {
  const span = spans.find((candidate) => candidate.text.includes(needle));
  if (span === undefined) throw new Error(`no span containing ${JSON.stringify(needle)}`);
  const [red, green, blue] = span.fg.toInts();
  return `#${[red, green, blue]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

/**
 * Ink is every cell that is neither whitespace nor frame chrome, and only the
 * rail and the rules count as chrome — the narrowest reading, so the budget
 * cannot be met by reclassifying content as decoration. `strictInk` counts even
 * the chrome, and is reported alongside so the number cannot be flattered by the
 * definition.
 */
function chromeGlyphs(): Set<string> {
  const glyphs = getGlyphs();
  return new Set([glyphs.rail, glyphs.railDeep, glyphs.divider]);
}

function inkOf(row: string, chrome: Set<string>): number {
  return [...row].filter((character) => character.trim().length > 0 && !chrome.has(character))
    .length;
}

interface Density {
  readonly ink: number;
  readonly strictInk: number;
  readonly breathing: number;
}

function density(rows: readonly string[], viewport: Viewport): Density {
  const chrome = chromeGlyphs();
  const empty = new Set<string>();
  const cells = viewport.width * rows.length;
  return {
    ink: rows.reduce((total, row) => total + inkOf(row, chrome), 0) / cells,
    strictInk: rows.reduce((total, row) => total + inkOf(row, empty), 0) / cells,
    breathing: rows.filter((row) => inkOf(row, chrome) === 0).length / rows.length,
  };
}

function report(label: string, measured: Density): void {
  console.log(
    `${label}: ink ${(measured.ink * 100).toFixed(1)}% · counting chrome ${(measured.strictInk * 100).toFixed(1)}% · breathing ${(measured.breathing * 100).toFixed(1)}%`,
  );
}

describe("density", () => {
  it("holds a realistic session under 22% ink with over 40% breathing rows", async () => {
    const { rows } = await render(transcript(SESSION, WIDE), WIDE);
    const measured = density(rows, WIDE);

    // Printed because the number, not the assertion, is the design's contract.
    report("120x34", measured);

    expect(measured.ink).toBeLessThanOrEqual(0.22);
    // The budget holds even if the rails are counted as content.
    expect(measured.strictInk).toBeLessThanOrEqual(0.22);
    expect(measured.breathing).toBeGreaterThanOrEqual(0.4);
  });

  /**
   * At 80 columns the frame *is* the measure — `measureFor` has no surplus left
   * to be sparse with, so a full prose row is 95% ink by arithmetic and the ≤22%
   * budget is unreachable at any content. The same session measures 15.9% at 120.
   * What must survive the squeeze is the breathing, and it does.
   */
  it("keeps the breathing rows when the frame is the measure", async () => {
    const { rows } = await render(transcript(SESSION, NARROW), NARROW);
    const measured = density(rows, NARROW);
    report("80x34", measured);
    expect(measured.ink).toBeLessThanOrEqual(0.26);
    expect(measured.breathing).toBeGreaterThanOrEqual(0.4);
  });

  it("opens every turn with a blank row", () => {
    const rows = transcriptRows(SESSION, WIDE);
    const agentIndex = rows.findIndex((row) => row.key.startsWith("a1:"));
    expect(agentIndex).toBeGreaterThan(0);
    expect(rows[agentIndex - 1]?.content).toHaveLength(0);
  });
});

describe("the measure", () => {
  it("never lets a row overflow the viewport, at 120 or at 80", async () => {
    for (const viewport of [WIDE, NARROW]) {
      const { rows } = await render(transcript(SESSION, viewport), viewport);
      expect(rows).toHaveLength(viewport.height);
      for (const row of rows) {
        expect([...row]).toHaveLength(viewport.width);
        // Metadata stops two columns short, so the frame edge is always clear.
        expect(row.slice(viewport.width - 2)).toBe("  ");
      }
    }
  });

  it("keeps running prose inside 88 columns however wide the terminal is", () => {
    for (const width of [80, 120, 200]) {
      const rows = transcriptRows(SESSION, { width, height: 34 });
      const prose = rows.filter(
        (row) =>
          (row.key.startsWith("u1:") || /^a1:\d+:/.test(row.key)) && !row.key.includes(":table:"),
      );
      expect(prose.length).toBeGreaterThan(0);
      for (const row of prose) {
        expect(row.contentWidth).toBeLessThanOrEqual(PROSE_MEASURE);
        const used = row.content.reduce((total, segment) => total + [...segment.text].length, 0);
        expect(used).toBeLessThanOrEqual(row.contentWidth);
      }
    }
  });

  it("gives tables and expanded output the full width instead", () => {
    const rows = transcriptRows(SESSION, WIDE);
    const table = rows.filter((row) => row.key.includes(":table:"));
    const detail = rows.filter((row) => row.key.includes(":detail:"));
    expect(table.length).toBe(4);
    expect(detail.length).toBe(3);
    for (const row of [...table, ...detail]) {
      expect(row.contentWidth).toBeGreaterThan(PROSE_MEASURE);
    }
  });

  /**
   * A 200-column window does not get a 200-column transcript: the page stops at
   * 120 and the frame widens around it. Otherwise the metadata column ends up a
   * hundred columns from the sentence it annotates, which is not flush right —
   * it is lost.
   */
  it("stops widening past a page, so nothing stretches on a huge terminal", async () => {
    const wide: Viewport = { width: 200, height: 34 };
    const { rows } = await render(transcript(SESSION, wide), wide);
    for (const row of rows) {
      expect([...row]).toHaveLength(200);
      expect(row.trimEnd().length).toBeLessThanOrEqual(120);
    }
    expect(rows.some((row) => row.includes("14:32"))).toBe(true);
  });

  it("puts the timestamp in the metadata column, not in the sentence", async () => {
    const { rows } = await render(transcript(SESSION, WIDE), WIDE);
    const row = rows.find((line) => line.includes("14:32"));
    expect(row).toBeDefined();
    // Flush right: the timestamp sits past the prose measure.
    expect((row ?? "").indexOf("14:32")).toBeGreaterThan(PROSE_MEASURE);
  });
});

describe("tool receipts", () => {
  it("shows a settled call as a receipt with no marker, status word or duration", async () => {
    const { rows } = await render(transcript(SESSION, WIDE), WIDE);
    const row = rows.find((line) => line.includes("4 flagged of 26")) ?? "";

    expect(row).toContain("gmail  4 flagged of 26");
    expect(row).not.toContain("1.9s");
    expect(row).not.toContain("ok");
    expect(row).not.toContain(getGlyphs().success);
  });

  it("packs several settled receipts onto one row", async () => {
    const { rows } = await render(transcript(SESSION, WIDE), WIDE);
    const row = rows.find((line) => line.includes("4 flagged of 26")) ?? "";
    expect(row).toContain("3 sources");
    expect(row).toContain("2 conflicts");
  });

  it("keeps a colour for failure, and states the reason and the way out", async () => {
    const { rows, spans } = await render(transcript(SESSION, WIDE), WIDE);
    const row = rows.find((line) => line.includes("could not read")) ?? "";

    expect(row).toContain("read-only connection");
    expect(row).toContain("ctrl+a reconnects");
    expect(colorOf(spans, "could not read")).toBe(THEME.error.toUpperCase());
  });

  it("collapses reasoning to one dim line of steps, duration and the key", async () => {
    const { rows, spans } = await render(transcript(SESSION, WIDE), WIDE);
    const row = rows.find((line) => line.includes("thought")) ?? "";

    expect(row).toContain("8 steps");
    expect(row).toContain("ctrl+o expands");
    expect(row).toContain("3.2s");
    expect(colorOf(spans, "thought")).toBe(THEME.muted.toUpperCase());
  });
});

describe("reasoning is subordinate by geometry", () => {
  const expanded: readonly Block[] = [
    {
      id: "r",
      seq: 1,
      kind: "reasoning",
      collapsed: false,
      text: "The flagged threads split three ways: two need a reply, one needs a decision I cannot make, and the clinic one is a calendar write.",
      steps: 8,
      durationMs: 3_200,
    },
  ];

  it("sets it narrower than prose, indented, dim and never bold", async () => {
    const rows = transcriptRows(expanded, WIDE);
    const widest = Math.max(
      ...rows.map((row) => row.content.reduce((total, seg) => total + [...seg.text].length, 0)),
    );
    expect(widest).toBeLessThan(PROSE_MEASURE);
    for (const row of rows) {
      for (const segment of row.content) expect(segment.bold).not.toBe(true);
      // The deep rail, not a new hue, is what says "one level down".
      expect(row.gutter[0]?.text).toBe(getGlyphs().railDeep);
    }

    const { spans } = await render(transcript(expanded, WIDE), WIDE);
    expect(colorOf(spans, "flagged threads")).toBe(THEME.muted.toUpperCase());
  });
});

describe("notices and dividers", () => {
  it("marks a notice by tone and rules a divider out to the full width", async () => {
    const blocks: readonly Block[] = [
      { id: "n", seq: 1, kind: "notice", text: "context is 82% full", tone: "warn" },
      { id: "d", seq: 2, kind: "divider", label: "resumed" },
    ];
    const rows = transcriptRows(blocks, WIDE);
    expect(rows.find((row) => row.key.startsWith("n:"))?.gutter[0]?.text).toBe(getGlyphs().warn);
    expect(rows.find((row) => row.key.startsWith("d:"))?.contentWidth).toBeGreaterThan(
      PROSE_MEASURE,
    );

    const { rows: frame, spans } = await render(transcript(blocks, WIDE), WIDE);
    expect(frame.join("\n")).toContain("resumed");
    expect(colorOf(spans, "context is 82% full")).toBe(THEME.warning.toUpperCase());
  });
});

describe("colour is state, not speaker", () => {
  it("sets settled chrome on the neutral ramp and agent prose at full contrast", async () => {
    const { spans } = await render(transcript(SESSION, WIDE), WIDE);

    expect(colorOf(spans, "Four things need you")).toBe(THEME.selected.toUpperCase());
    expect(colorOf(spans, "gmail")).toBe(THEME.muted.toUpperCase());
    // The user's own marker is the one speaker-coloured cell; the rail is not.
    expect(colorOf(spans, getGlyphs().promptCursor)).toBe(THEME.primary.toUpperCase());
    expect(colorOf(spans, getGlyphs().rail)).toBe(THEME.border.toUpperCase());
  });

  it("puts the accent on a streaming rail and takes it away once settled", async () => {
    const streaming: readonly Block[] = [
      { id: "a", seq: 1, kind: "agent", markdown: "still typing", streaming: true },
    ];
    const settled: readonly Block[] = [{ id: "a", seq: 1, kind: "agent", markdown: "all done" }];

    const live = await render(transcript(streaming, WIDE), WIDE);
    expect(colorOf(live.spans, getGlyphs().diamond)).toBe(THEME.agent.toUpperCase());

    const done = await render(transcript(settled, WIDE), WIDE);
    expect(colorOf(done.spans, getGlyphs().diamond)).toBe(THEME.secondary.toUpperCase());
  });
});

describe("lanes", () => {
  it("gives depth a column, so the content column never moves", () => {
    const lanes: readonly Block[] = [
      {
        id: "l1",
        seq: 1,
        kind: "lane",
        name: "travel-scout",
        ask: "check the Basel dates",
        lane: 1,
        state: "running",
      },
      {
        id: "l2",
        seq: 2,
        kind: "lane",
        name: "inbox-sifter",
        ask: "rank the flagged threads",
        lane: 2,
        state: "running",
      },
    ];
    const rows = transcriptRows(lanes, WIDE);
    const plain = transcriptRows([{ id: "u", seq: 1, kind: "user", text: "hello" }], WIDE);

    // Same content width at depth 0 and inside a lane: depth costs no measure.
    expect(rows[0]?.contentWidth).toBe(plain[0]?.contentWidth);
    // Two gutter cells for every row, delegated or not, so the content column
    // is in the same place whatever the depth.
    for (const row of rows) expect(row.gutter).toHaveLength(2);
    for (const row of plain) expect(row.gutter).toHaveLength(2);

    // Two concurrent lanes are told apart in the metadata column, not in the
    // gutter. Printed in the gutter the number abutted the name and read as one
    // token — `1travel-scout` — which is worse than not distinguishing them.
    const first = rows[0];
    const second = rows.find((row) => row.key.startsWith("l2"));
    expect(first?.gutter[1]?.text.trim()).toBe("");
    expect(first?.meta.map((segment) => segment.text).join("")).toContain("lane 1");
    expect(second?.meta.map((segment) => segment.text).join("")).toContain("lane 2");
  });
});

describe("newBelow", () => {
  it("marks the count and the key, flush right and bright, on one row", async () => {
    const quiet = await render(transcript(SESSION, WIDE), WIDE);
    const loud = await render(transcript(SESSION, WIDE, 3), WIDE);

    const marker = loud.rows.find((row) => row.includes("new below")) ?? "";
    expect(marker).toContain("3 new below");
    expect(marker).toContain("end jumps");
    expect(colorOf(loud.spans, "new below")).toBe(THEME.primary.toUpperCase());

    // It overlays the last row rather than taking one, so nothing above shifts.
    expect(loud.rows).toHaveLength(quiet.rows.length);
    expect(loud.rows.slice(0, WIDE.height - 1)).toEqual(quiet.rows.slice(0, WIDE.height - 1));
    expect(quiet.rows.join("\n")).not.toContain("new below");
  });
});
