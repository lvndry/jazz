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

import { TextAttributes, type CapturedSpan } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { beforeAll, describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { getGlyphs } from "../glyphs";
import { setThemeVariant, THEME } from "../theme";
import { terminalCellWidth } from "./terminal-cells";
import {
  inlineSegments,
  parseProse,
  Transcript,
  transcriptRows,
  type RenderRow,
} from "./Transcript";
import { measureFor, PROSE_MEASURE, type Block, type Viewport } from "./types";

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

describe("terminal-cell wrapping", () => {
  it("keeps narrow frame rows exact and graphemes intact", async () => {
    const viewport = { width: 60, height: 8 };
    const family = "👨‍👩‍👧‍👦";
    const rendered = await render(
      transcript(
        [
          {
            id: "wide",
            seq: 1,
            kind: "user",
            text: `漢字 ${family} cafe\u0301 `.repeat(12),
          },
        ],
        viewport,
      ),
      viewport,
    );

    for (const row of rendered.rows) expect(terminalCellWidth(row)).toBe(viewport.width);
    const text = rendered.rows.join("\n");
    if (text.includes("👨")) expect(text).toContain(family);
  });
});

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

  it("widens running prose with the terminal instead of leaving a dead band", () => {
    const widths = [80, 120, 200] as const;
    const proseWidths: number[] = [];
    for (const width of widths) {
      const expected = measureFor(width).prose;
      const rows = transcriptRows(SESSION, { width, height: 34 });
      const prose = rows.filter(
        (row) =>
          (row.key.startsWith("u1:") || /^a1:\d+:/.test(row.key)) && !row.key.includes(":table:"),
      );
      expect(prose.length).toBeGreaterThan(0);
      for (const row of prose) {
        expect(row.contentWidth).toBe(expected);
        const used = row.content.reduce((total, segment) => total + [...segment.text].length, 0);
        expect(used).toBeLessThanOrEqual(row.contentWidth);
      }
      proseWidths.push(expected);
    }
    expect(proseWidths[0]).toBeLessThan(PROSE_MEASURE);
    expect(proseWidths[1]).toBeGreaterThan(PROSE_MEASURE);
    expect(proseWidths[2]).toBeGreaterThan(proseWidths[1] ?? 0);
  });

  it("gives tables and expanded output the full width instead", () => {
    const rows = transcriptRows(SESSION, WIDE);
    const table = rows.filter((row) => /:table:\d+:\d+$/.test(row.key));
    const detail = rows.filter((row) => row.key.includes(":detail:"));
    expect(table.length).toBe(4);
    expect(detail.length).toBe(3);
    const measure = measureFor(WIDE.width);
    for (const row of [...table, ...detail]) {
      expect(row.contentWidth).toBe(measure.prose + measure.metadata);
      expect(row.contentWidth).toBeGreaterThan(measure.prose);
    }
  });

  it("separates logical table rows with a blank row", () => {
    const rows = transcriptRows(SESSION, WIDE);
    const first = rows.findIndex((row) => row.key.includes(":table:0:0"));
    const second = rows.findIndex((row) => row.key.includes(":table:1:0"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBe(first + 2);
    expect(rows[first + 1]?.content).toEqual([]);
  });

  it("keeps every cell that fits the content measure", () => {
    const rows = transcriptRows(SESSION, WIDE);
    const text = rows
      .filter((row) => row.key.includes(":table:"))
      .map((row) => row.content.map((segment) => segment.text).join(""))
      .join("\n");
    expect(text).toContain("From");
    expect(text).toContain("Subject");
    expect(text).toContain("Action");
    expect(text).toContain("Dana Okafor");
    expect(text).toContain("Q3 board deck");
    expect(text).toContain("numbers Thursday");
    expect(text).toContain("confirm or rebook");
  });

  it("wraps a wide cell instead of cropping it", async () => {
    const note = "Thursday numbers must land before the board packet goes out to every director.";
    const blocks: readonly Block[] = [
      {
        id: "a",
        seq: 1,
        kind: "agent",
        markdown: ["| Name | Notes |", "| --- | --- |", `| Dana | ${note} |`].join("\n"),
      },
    ];
    const rows = transcriptRows(blocks, NARROW);
    const table = rows.filter((row) => row.key.includes(":table:"));
    const text = table
      .map((row) => row.content.map((segment) => segment.text).join(""))
      .join(" ")
      .replace(/\s+/g, " ");
    expect(text).toContain("Thursday numbers");
    expect(text).toContain("every director");
    expect(table.length).toBeGreaterThan(2);

    const rendered = await render(transcript(blocks, NARROW), NARROW);
    const frame = rendered.rows.join("\n");
    expect(frame).toContain("Thursday numbers");
    expect(frame).toContain("director");
  });

  it("does not eat a short header when leftover width would have kept it", () => {
    const long = "x".repeat(70);
    const blocks: readonly Block[] = [
      {
        id: "a",
        seq: 1,
        kind: "agent",
        markdown: ["| Hello | Notes |", "| --- | --- |", `| Hello | ${long} |`].join("\n"),
      },
    ];
    const text = transcriptRows(blocks, NARROW)
      .filter((row) => row.key.includes(":table:"))
      .map((row) => row.content.map((segment) => segment.text).join(""))
      .join("\n");
    expect(text).toContain("Hello");
    expect(text).not.toMatch(/Hell[^o]/);
  });

  it("keeps the last column when many narrow columns share the measure", () => {
    const headers = Array.from({ length: 20 }, (_, index) => String.fromCharCode(65 + index));
    const cells = headers.map((header) => header.toLowerCase());
    const blocks: readonly Block[] = [
      {
        id: "a",
        seq: 1,
        kind: "agent",
        markdown: [
          `| ${headers.join(" | ")} |`,
          `| ${headers.map(() => "---").join(" | ")} |`,
          `| ${cells.join(" | ")} |`,
        ].join("\n"),
      },
    ];
    const text = transcriptRows(blocks, NARROW)
      .filter((row) => row.key.includes(":table:"))
      .map((row) => row.content.map((segment) => segment.text).join(""))
      .join("\n");
    expect(text).toContain("A");
    expect(text).toContain("T");
    expect(text).toContain("t");
  });

  /**
   * A 200-column window gets a 200-column transcript. The empty band past 120
   * was unused page, not a reading measure; prose and tables take the surplus
   * so metadata stays on the same row as the sentence it annotates.
   */
  it("uses the full terminal width, so nothing is stranded on a huge terminal", async () => {
    const wide: Viewport = { width: 200, height: 34 };
    const { rows } = await render(transcript(SESSION, wide), wide);
    const measure = measureFor(wide.width);
    for (const row of rows) {
      expect([...row]).toHaveLength(200);
      expect(row.slice(wide.width - 2)).toBe("  ");
    }
    expect(rows.some((row) => row.trimEnd().length > 120)).toBe(true);
    const stamped = rows.find((line) => line.includes("14:32")) ?? "";
    expect(stamped.indexOf("14:32")).toBeGreaterThan(measure.prose);
  });

  it("puts the timestamp in the metadata column, not in the sentence", async () => {
    const { rows } = await render(transcript(SESSION, WIDE), WIDE);
    const row = rows.find((line) => line.includes("14:32"));
    expect(row).toBeDefined();
    expect((row ?? "").indexOf("14:32")).toBeGreaterThan(measureFor(WIDE.width).prose);
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

  it("wraps a long failure reason instead of cropping it", async () => {
    const reason =
      "Command blocked by the built-in safety denylist: running inline code via an interpreter flag (-c/-e) is on the blocked list; write the code to a temp file and run that instead.";
    const blocks: readonly Block[] = [
      {
        id: "t",
        seq: 1,
        kind: "tool",
        app: "execute_command",
        args: `command: "python3 -c \\"import reportlab; print(reportlab.__version__)\\""`,
        summary: `execute_command: ${reason.slice(0, 80)}…`,
        status: "failed",
        reason,
      },
    ];
    const text = transcriptRows(blocks, NARROW)
      .map((row) => row.content.map((segment) => segment.text).join(""))
      .join("\n");

    expect(text).toContain("write the code to a temp file");
    expect(text).toContain("interpreter flag");
    expect(text).not.toContain("running inline code v…");
    expect(text.split("\n").length).toBeGreaterThan(1);
  });

  it("collapses reasoning to one dim line of steps, duration and the key", async () => {
    const { rows, spans } = await render(transcript(SESSION, WIDE), WIDE);
    const row = rows.find((line) => line.includes("thought")) ?? "";

    expect(row).toContain("8 steps");
    expect(row).toContain("ctrl+r expands");
    expect(row).toContain("3.2s");
    expect(colorOf(spans, "thought")).toBe(THEME.muted.toUpperCase());
  });

  it("shows the arguments used and a snippet of what came back", async () => {
    const blocks: readonly Block[] = [
      {
        id: "t",
        seq: 1,
        kind: "tool",
        app: "view_memory",
        args: "path: /",
        summary: "Here're the files · /notes.txt",
        status: "ok",
      },
    ];
    const { rows } = await render(transcript(blocks, WIDE), WIDE);
    const row = rows.find((line) => line.includes("view_memory")) ?? "";
    expect(row).toContain("path: /");
    expect(row).toContain("/notes.txt");
  });

  it("states the classifier verdict on a settled command receipt", async () => {
    const blocks: readonly Block[] = [
      {
        id: "t",
        seq: 1,
        kind: "tool",
        app: "execute_command",
        args: 'command: "python3 --version"',
        summary: "Python 3.14.5",
        status: "ok",
        classifiedRisk: "read-only",
      },
    ];
    const { rows } = await render(transcript(blocks, WIDE), WIDE);
    const row = rows.find((line) => line.includes("python3 --version")) ?? "";
    expect(row).toContain("Python 3.14.5");
    expect(row).toContain("read-only");
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
    expect(widest).toBeLessThan(measureFor(WIDE.width).prose);
    for (const row of rows) {
      for (const segment of row.content) expect(segment.bold).not.toBe(true);
      expect(row.gutter[0]?.text).toBe(" ");
    }

    const { spans } = await render(transcript(expanded, WIDE), WIDE);
    expect(colorOf(spans, "flagged threads")).toBe(THEME.muted.toUpperCase());
  });

  it("puts a blank row between consecutive reasoning blocks", () => {
    const blocks: readonly Block[] = [
      { id: "r1", seq: 1, kind: "reasoning", collapsed: false, text: "first thought" },
      { id: "r2", seq: 2, kind: "reasoning", collapsed: false, text: "second thought" },
    ];
    const rows = transcriptRows(blocks, WIDE);
    const second = rows.findIndex((row) =>
      row.content.some((segment) => segment.text.includes("second thought")),
    );
    expect(second).toBeGreaterThan(0);
    expect(rows[second - 1]?.key).toBe("gap:r2");
    expect(rows[second - 1]?.content).toEqual([]);
  });

  it("leaves a blank row after a **section** heading when expanded", () => {
    const blocks: readonly Block[] = [
      {
        id: "r",
        seq: 1,
        kind: "reasoning",
        collapsed: false,
        text: "**Reviewing tests**\nConsidering bun test flags.\n**Finding failures**\nMany passed.",
      },
    ];
    const rows = transcriptRows(blocks, WIDE);
    const texts = rows.map((row) => row.content.map((segment) => segment.text).join(""));
    const heading = texts.findIndex((text) => text.includes("Reviewing tests"));
    const body = texts.findIndex((text) => text.includes("Considering bun test"));
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(body).toBe(heading + 2);
    expect(texts[heading + 1]?.trim()).toBe("");
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
    expect(rows.find((row) => row.key.startsWith("d:"))?.contentWidth).toBe(
      measureFor(WIDE.width).prose + measureFor(WIDE.width).metadata,
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

    const rows = transcriptRows(SESSION, WIDE);
    const continuation = rows.find(
      (row) => row.key.startsWith("a1:") && row.gutter[0]?.text === " ",
    );
    expect(continuation?.gutter[0]?.fg).toBe(THEME.border);
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

describe("parenthesis ordered lists", () => {
  function rowText(rows: readonly RenderRow[], blockId: string): string[] {
    return rows
      .filter((row) => row.key.startsWith(`${blockId}:`))
      .map((row) => row.content.map((segment) => segment.text).join(""));
  }

  it("keeps 1) on its own line when the model omitted a blank line", () => {
    const markdown = [
      "Safer, low-risk options (what you can try with low downside)",
      "1) Cloves (whole or powdered)",
      "- What people use it for: antiparasitic",
      "",
      "2) Garlic (raw or aged extract)",
    ].join("\n");

    const items = parseProse(markdown);
    const texts = items.flatMap((item) => {
      if (item.kind === "text") return [item.segments.map((segment) => segment.text).join("")];
      return [];
    });
    expect(texts.some((text) => text.includes("low downside") && text.includes("1)"))).toBe(false);
    expect(texts.find((text) => text.includes("Cloves"))).toContain("1)");
    expect(texts.find((text) => text.includes("Garlic"))).toContain("2)");

    const rows = transcriptRows([{ id: "a", seq: 1, kind: "agent", markdown }], WIDE);
    const heading = rowText(rows, "a").find((line) => line.includes("low downside"));
    const cloves = rowText(rows, "a").find((line) => line.includes("Cloves"));
    expect(heading).toBeDefined();
    expect(cloves).toBeDefined();
    expect(heading).not.toContain("1)");
    expect(cloves).toContain("1)");
  });

  it("does not join consecutive parenthesis items that share no blank line", () => {
    const markdown = [
      "3) Monitor: stop and get medical testing.",
      "4) If you prefer a stronger attempt, read the dosing first.",
    ].join("\n");
    const items = parseProse(markdown);
    const texts = items.flatMap((item) => {
      if (item.kind === "text") return [item.segments.map((segment) => segment.text).join("")];
      return [];
    });
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("3)");
    expect(texts[0]).not.toContain("4)");
    expect(texts[1]).toContain("4)");
  });

  it("still turns 1. into a bullet", () => {
    const items = parseProse("Heading\n1. Cloves");
    const texts = items.flatMap((item) => {
      if (item.kind === "text") return [item.segments.map((segment) => segment.text).join("")];
      return [];
    });
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain(getGlyphs().bullet);
    expect(texts[1]).not.toContain("1.");
  });
});

describe("inline emphasis", () => {
  function flagsOf(segment: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
  }): {
    readonly bold: boolean;
    readonly italic: boolean;
    readonly underline: boolean;
    readonly strikethrough: boolean;
  } {
    return {
      bold: segment.bold === true,
      italic: segment.italic === true,
      underline: segment.underline === true,
      strikethrough: segment.strikethrough === true,
    };
  }

  function spanWith(spans: readonly CapturedSpan[], needle: string): CapturedSpan {
    const exact = spans.find((candidate) => candidate.text.trim() === needle);
    const span = exact ?? spans.find((candidate) => candidate.text.includes(needle));
    if (span === undefined) throw new Error(`no span containing ${JSON.stringify(needle)}`);
    return span;
  }

  it("tokenises weight, slant, underline and strike without spending a hue", () => {
    const fg = THEME.secondary;
    const segments = inlineSegments(
      "plain **bold** __also bold__ *italic* _also italic_ ***both*** <u>under</u> ~~old~~ `code` [label](https://example.com)",
      fg,
    );

    expect(segments.map((segment) => segment.text).join("")).toBe(
      "plain bold also bold italic also italic both under old code label",
    );

    const byText = Object.fromEntries(segments.map((segment) => [segment.text.trim(), segment]));
    expect(flagsOf(byText["plain"]!)).toEqual({
      bold: false,
      italic: false,
      underline: false,
      strikethrough: false,
    });
    expect(flagsOf(byText["bold"]!)).toEqual({
      bold: true,
      italic: false,
      underline: false,
      strikethrough: false,
    });
    expect(flagsOf(byText["also bold"]!)).toEqual({
      bold: true,
      italic: false,
      underline: false,
      strikethrough: false,
    });
    expect(flagsOf(byText["italic"]!)).toEqual({
      bold: false,
      italic: true,
      underline: false,
      strikethrough: false,
    });
    expect(flagsOf(byText["also italic"]!)).toEqual({
      bold: false,
      italic: true,
      underline: false,
      strikethrough: false,
    });
    expect(flagsOf(byText["both"]!)).toEqual({
      bold: true,
      italic: true,
      underline: false,
      strikethrough: false,
    });
    expect(flagsOf(byText["under"]!)).toEqual({
      bold: false,
      italic: false,
      underline: true,
      strikethrough: false,
    });
    expect(flagsOf(byText["old"]!)).toEqual({
      bold: false,
      italic: false,
      underline: false,
      strikethrough: true,
    });

    expect(byText["bold"]?.fg).toBe(fg);
    expect(byText["italic"]?.fg).toBe(fg);
    expect(byText["both"]?.fg).toBe(fg);
    expect(byText["under"]?.fg).toBe(fg);
    expect(byText["old"]?.fg).toBe(fg);
    expect(byText["code"]?.fg).toBe(THEME.syntaxValue);
    expect(byText["label"]?.fg).toBe(THEME.link);
  });

  it("nests overlapping emphasis without leftover markers", () => {
    const nested = inlineSegments("**bold *and italic* still**", THEME.selected);
    expect(nested.map((segment) => segment.text).join("")).toBe("bold and italic still");
    expect(nested.every((segment) => !segment.text.includes("*"))).toBe(true);
    expect(nested.find((segment) => segment.text.includes("bold"))?.bold).toBe(true);
    expect(nested.find((segment) => segment.text.includes("and italic"))).toMatchObject({
      bold: true,
      italic: true,
    });
    expect(nested.find((segment) => segment.text.includes("still"))?.italic).not.toBe(true);

    const reversed = inlineSegments("*italic **and bold** still*", THEME.selected);
    expect(reversed.map((segment) => segment.text).join("")).toBe("italic and bold still");
    expect(reversed.find((segment) => segment.text.includes("and bold"))).toMatchObject({
      bold: true,
      italic: true,
    });
  });

  it("leaves intraword underscores alone", () => {
    const segments = inlineSegments("see bail_logement_loue and foo_bar_baz", THEME.selected);
    expect(segments).toEqual([
      { text: "see bail_logement_loue and foo_bar_baz", fg: THEME.selected },
    ]);
  });

  it("keeps a wrap point inside a bold run bold on both rows", () => {
    const blocks: readonly Block[] = [
      {
        id: "a",
        seq: 1,
        kind: "agent",
        markdown: `**${"urgent ".repeat(20).trim()}**`,
      },
    ];
    const rows = transcriptRows(blocks, NARROW).filter((row) => row.key.startsWith("a:"));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      for (const segment of row.content) {
        if (segment.text.trim().length === 0) continue;
        expect(segment.bold).toBe(true);
      }
    }
  });

  it("paints bold italic underline and strike as attributes, not a hue", async () => {
    const blocks: readonly Block[] = [
      {
        id: "a",
        seq: 1,
        kind: "agent",
        markdown: "Use **bold** and *italic* and ***both*** and <u>under</u> and ~~gone~~ here.",
      },
    ];
    const { spans } = await render(transcript(blocks, WIDE), WIDE);

    expect(spanWith(spans, "bold").attributes & TextAttributes.BOLD).not.toBe(0);
    expect(spanWith(spans, "bold").attributes & TextAttributes.ITALIC).toBe(0);
    expect(spanWith(spans, "italic").attributes & TextAttributes.ITALIC).not.toBe(0);
    expect(spanWith(spans, "italic").attributes & TextAttributes.BOLD).toBe(0);
    expect(spanWith(spans, "both").attributes & TextAttributes.BOLD).not.toBe(0);
    expect(spanWith(spans, "both").attributes & TextAttributes.ITALIC).not.toBe(0);
    expect(spanWith(spans, "under").attributes & TextAttributes.UNDERLINE).not.toBe(0);
    expect(spanWith(spans, "gone").attributes & TextAttributes.STRIKETHROUGH).not.toBe(0);

    expect(colorOf(spans, "Use")).toBe(THEME.selected.toUpperCase());
    expect(colorOf(spans, "bold")).toBe(THEME.selected.toUpperCase());
    expect(colorOf(spans, "italic")).toBe(THEME.selected.toUpperCase());
    expect(colorOf(spans, "both")).toBe(THEME.selected.toUpperCase());
    expect(colorOf(spans, "under")).toBe(THEME.selected.toUpperCase());
    expect(colorOf(spans, "gone")).toBe(THEME.selected.toUpperCase());
  });

  it("keeps quoted emphasis on the quote colour", () => {
    const rows = transcriptRows(
      [{ id: "a", seq: 1, kind: "agent", markdown: "> a **warning** and *aside*" }],
      WIDE,
    );
    const warning = rows
      .flatMap((row) => row.content)
      .find((segment) => segment.text.includes("warning"));
    const aside = rows
      .flatMap((row) => row.content)
      .find((segment) => segment.text.includes("aside"));
    expect(warning).toMatchObject({ fg: THEME.secondary, bold: true });
    expect(aside).toMatchObject({ fg: THEME.secondary, italic: true });
  });

  it("highlights a fenced body with the three syntax roles", () => {
    const rows = transcriptRows(
      [
        {
          id: "a",
          seq: 1,
          kind: "agent",
          markdown: '```ts\nconst name = "jazz";\nfunction Agent() {}\n```',
        },
      ],
      WIDE,
    );
    const content = rows.flatMap((row) => row.content);
    expect(content.find((segment) => segment.text === "const")?.fg).toBe(THEME.syntaxStructure);
    expect(content.find((segment) => segment.text.includes("jazz"))?.fg).toBe(THEME.syntaxValue);
    expect(content.find((segment) => segment.text === "Agent")?.fg).toBe(THEME.syntaxType);
  });

  it("paints an expanded patch as a unified diff", () => {
    const rows = transcriptRows(
      [
        {
          id: "t",
          seq: 1,
          kind: "tool",
          app: "files",
          summary: "edited note",
          status: "ok",
          expanded: true,
          detail: ["--- a/note.md", "+++ b/note.md", "-old line", "+new line"].join("\n"),
        },
      ],
      WIDE,
    );
    const content = rows
      .filter((row) => row.key.includes(":detail:"))
      .flatMap((row) => row.content);
    expect(content.find((segment) => segment.text === "-")?.fg).toBe(THEME.error);
    expect(content.find((segment) => segment.text === "+")?.fg).toBe(THEME.success);
  });

  it("paints expanded write/edit bodies with the syntax roles", () => {
    const rows = transcriptRows(
      [
        {
          id: "t",
          seq: 1,
          kind: "tool",
          app: "",
          summary: "",
          status: "ok",
          expanded: true,
          detail: 'def main():\n    return "jazz"',
        },
      ],
      WIDE,
    );
    const content = rows
      .filter((row) => row.key.includes(":detail:"))
      .flatMap((row) => row.content);
    expect(content.find((segment) => segment.text === "def")?.fg).toBe(THEME.syntaxStructure);
    expect(content.find((segment) => segment.text.includes("jazz"))?.fg).toBe(THEME.syntaxValue);
  });
});

describe("wrap depends on width, not height", () => {
  it("produces the same rows when only viewport height changes", () => {
    const tall = transcriptRows(SESSION, { width: 120, height: 34 });
    const short = transcriptRows(SESSION, { width: 120, height: 8 });
    expect(short).toEqual(tall);
  });
});

describe("wrap cache", () => {
  it("returns the same row array by reference when blocks and width are unchanged", () => {
    const first = transcriptRows(SESSION, WIDE);
    const second = transcriptRows(SESSION, WIDE);
    expect(second).toBe(first);
    expect(second).toEqual(first);
  });

  it("busts the cache when reasoning collapse changes", () => {
    const collapsed: readonly Block[] = [
      { id: "r", seq: 1, kind: "reasoning", collapsed: true, text: "secret plan" },
    ];
    const expanded: readonly Block[] = [
      { id: "r", seq: 1, kind: "reasoning", collapsed: false, text: "secret plan" },
    ];
    const hidden = transcriptRows(collapsed, WIDE);
    const shown = transcriptRows(expanded, WIDE);
    expect(shown).not.toBe(hidden);
    expect(shown).not.toEqual(hidden);
    expect(transcriptRows(collapsed, WIDE)).toEqual(hidden);
  });

  it("busts the cache when tool expand or detail changes", () => {
    const base: Block = {
      id: "t",
      seq: 1,
      kind: "tool",
      app: "files",
      summary: "wrote note",
      status: "ok",
    };
    const collapsed = transcriptRows([base], WIDE);
    const expanded = transcriptRows([{ ...base, expanded: true, detail: "full output" }], WIDE);
    expect(expanded).not.toBe(collapsed);
    expect(expanded).not.toEqual(collapsed);
    const rewritten = transcriptRows([{ ...base, expanded: true, detail: "other output" }], WIDE);
    expect(rewritten).not.toEqual(expanded);
  });

  it("re-wraps nothing when the same blocks arrive in a fresh array", () => {
    // Breathing rows are cheap and built per frame; every wrapped row should
    // come straight back out of the cache.
    const wrapped = (blocks: readonly Block[]): RenderRow[] =>
      transcriptRows(blocks, WIDE).filter((row) => !row.key.startsWith("gap:"));
    const first = wrapped([...SESSION]);
    const second = wrapped([...SESSION]);
    expect(second.length).toBe(first.length);
    expect(first.length).toBeGreaterThan(0);
    for (let index = 0; index < first.length; index += 1) {
      expect(second[index]).toBe(first[index]);
    }
  });

  it("busts a receipt run when a later call joins it", () => {
    const read: Block = {
      id: "t1",
      seq: 1,
      kind: "tool",
      app: "files",
      summary: "read note",
      status: "ok",
    };
    const write: Block = {
      id: "t2",
      seq: 2,
      kind: "tool",
      app: "files",
      summary: "wrote note",
      status: "ok",
    };
    const alone = transcriptRows([read], WIDE);
    const paired = transcriptRows([read, write], WIDE);
    expect(paired).not.toEqual(alone);
    expect(transcriptRows([read], WIDE)).toEqual(alone);
  });

  it("reuses settled block rows while a streaming tail misses", () => {
    const user: Block = { id: "u", seq: 1, kind: "user", text: "hello" };
    const first = transcriptRows(
      [user, { id: "a", seq: 2, kind: "agent", markdown: "hel", streaming: true }],
      WIDE,
    );
    const second = transcriptRows(
      [user, { id: "a", seq: 2, kind: "agent", markdown: "hello", streaming: true }],
      WIDE,
    );
    expect(second).not.toBe(first);
    const firstUser = first.filter((row) => row.key.startsWith("u:"));
    const secondUser = second.filter((row) => row.key.startsWith("u:"));
    expect(secondUser.length).toBeGreaterThan(0);
    expect(secondUser).toEqual(firstUser);
    for (let index = 0; index < firstUser.length; index += 1) {
      expect(secondUser[index]).toBe(firstUser[index]);
    }
  });

  it("invalidates wrapped rows when width changes", () => {
    const wide = transcriptRows(SESSION, WIDE);
    const narrow = transcriptRows(SESSION, NARROW);
    expect(narrow).not.toBe(wide);
    expect(narrow).not.toEqual(wide);
    expect(transcriptRows(SESSION, WIDE)).toEqual(wide);
  });

  it("invalidates wrapped rows when the theme variant switches", () => {
    const blocks: readonly Block[] = [{ id: "u", seq: 1, kind: "user", text: "hello" }];
    const dark = transcriptRows(blocks, WIDE);
    try {
      setThemeVariant("light");
      const light = transcriptRows(blocks, WIDE);
      expect(light).not.toBe(dark);
      const darkColors = dark.flatMap((row) => row.content.map((segment) => segment.fg));
      const lightColors = light.flatMap((row) => row.content.map((segment) => segment.fg));
      expect(lightColors).not.toEqual(darkColors);
    } finally {
      setThemeVariant("dark");
    }
  });
});
