/** @jsxImportSource @opentui/react */

/**
 * The live zone and the composer, asserted as characters.
 *
 * These are not smoke tests. Each one names a property the design depends on
 * and would silently lose to a plausible refactor: that the band's height does
 * not depend on how much work is in flight (so the input cannot move), that
 * hidden work is named rather than dropped, that parallel work looks parallel,
 * that motion stops when there is prose to read, and that nothing overflows at
 * the narrowest width the interface will draw at all.
 */

import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { describe, expect, it } from "bun:test";
import React from "react";
import { getGlyphs } from "../glyphs";
import { THEME } from "../theme";
import { Input, inputRows, MAX_VISIBLE_QUEUED, wrapCells, wrapCommandIndex } from "./Input";
import { liveRows, LiveZone } from "./LiveZone";
import { terminalCellWidth } from "./terminal-cells";
import {
  LIVE_ZONE_MAX_ROWS,
  MIN_WIDTH,
  type InputModel,
  type LiveModel,
  type LiveTool,
} from "./types";
import type { TodoSnapshotItem } from "../activity-state";

const WIDTH = 120;
const HEIGHT = 8;

/**
 * Named here rather than imported so a change to the cap has to be a deliberate
 * change to the test too — the cap is a design decision, not an implementation
 * detail.
 */
const INPUT_MAX_ROWS_EXPECTED = 6;

const glyphs = getGlyphs();

describe("wide and composed text", () => {
  it("wraps the composer by terminal cells without splitting graphemes", () => {
    expect(wrapCells("A漢👨‍👩‍👧‍👦e\u0301Z", 3)).toEqual(["A漢", "👨‍👩‍👧‍👦e\u0301", "Z"]);
  });

  it("keeps a narrow live row at exact terminal-cell width", () => {
    const [row] = liveRows(
      live({
        tools: [tool("音楽", "open 👨‍👩‍👧‍👦 cafe\u0301 records", 0)],
      }),
      { width: MIN_WIDTH, height: HEIGHT },
    );
    const text = row?.segments.map((segment) => segment.text).join("") ?? "";
    expect(terminalCellWidth(text)).toBe(MIN_WIDTH);
    if (text.includes("👨")) expect(text).toContain("👨‍👩‍👧‍👦");
  });
});

function tool(app: string, operation: string, phase: number, elapsedMs = 1000): LiveTool {
  return { app, operation, elapsedMs, phase };
}

/**
 * A model with the reservation defaulted to exactly what the frame needs, which
 * is what a freshly-grown adapter would hand over. Tests about the high-water
 * mark set `reservedRows` explicitly, because that is the property under test.
 */
function live(overrides: Partial<LiveModel> = {}): LiveModel {
  const model: LiveModel = { tools: [], hiddenTools: [], reservedRows: 0, ...overrides };
  if (overrides.reservedRows !== undefined) return model;
  const needed =
    model.tools.length +
    (model.hiddenTools.length > 0 ? 1 : 0) +
    (model.step === undefined ? 0 : 1) +
    (model.waiting === undefined ? 0 : 1);
  return { ...model, reservedRows: Math.min(LIVE_ZONE_MAX_ROWS, needed) };
}

/**
 * The band's height, measured rather than asserted from the inside.
 *
 * The filler above is bottom-justified and the anchor below is one row, so the
 * distance between them is exactly what the live zone occupies. That is the
 * only measurement that can tell a held row from a drawn one.
 */
function Harness({
  model,
  streaming,
  width = WIDTH,
}: {
  model: LiveModel;
  streaming?: boolean;
  width?: number;
}): React.ReactNode {
  return (
    <box style={{ width, height: HEIGHT, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "column", justifyContent: "flex-end" }}>
        <text>TOP</text>
      </box>
      <LiveZone
        model={model}
        viewport={{ width, height: HEIGHT }}
        {...(streaming === undefined ? {} : { streaming })}
      />
      <box style={{ height: 1, flexShrink: 0 }}>
        <text>ANCHOR</text>
      </box>
    </box>
  );
}

function rowsOf(frame: string): string[] {
  return frame.split("\n").filter((row) => row.length > 0);
}

async function bandHeight(
  model: LiveModel,
  options: { streaming?: boolean; width?: number } = {},
): Promise<{ height: number; frame: string }> {
  const width = options.width ?? WIDTH;
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <Harness
      model={model}
      width={width}
      {...(options.streaming === undefined ? {} : { streaming: options.streaming })}
    />,
    { width, height: HEIGHT },
  );
  await renderOnce();
  const frame = captureCharFrame();
  const rows = rowsOf(frame);
  const top = rows.findIndex((row) => row.includes("TOP"));
  const anchor = rows.findIndex((row) => row.includes("ANCHOR"));
  renderer.destroy();
  return { height: anchor - top - 1, frame };
}

describe("live zone", () => {
  it("renders nothing at all when nothing is in flight", async () => {
    const model = live();
    expect(liveRows(model, { width: WIDTH, height: HEIGHT })).toHaveLength(0);

    const { height, frame } = await bandHeight(model);
    expect(height).toBe(0);
    // The transcript's rows are genuinely returned, not merely blanked.
    expect(rowsOf(frame)[HEIGHT - 2]).toContain("TOP");
  });

  it("renders one row for one tool, naming the app and the operation", async () => {
    const model = live({ tools: [tool("gmail", "list threads", 0, 4200)] });
    const rows = liveRows(model, { width: WIDTH, height: HEIGHT });
    expect(rows).toHaveLength(1);

    const { frame } = await bandHeight(model);
    const content = rowsOf(frame).filter((row) => row.includes("gmail"));
    expect(content).toHaveLength(1);
    expect(content[0]).toContain("list threads");
    // Whole seconds, right-aligned. 4200ms is "4s", never "4.2s".
    expect(content[0]?.trimEnd().endsWith("4s")).toBe(true);
  });

  it("colours a write_file body when the path is source", () => {
    const model = live({
      tools: [
        {
          app: "write",
          operation: "file file: src/app.py  def main():",
          elapsedMs: 1000,
          phase: 0,
          language: "py",
        },
      ],
    });
    const [row] = liveRows(model, { width: WIDTH, height: HEIGHT });
    const defSpan = row?.segments.find((segment) => segment.text === "def");
    expect(defSpan?.fg).toBe(THEME.syntaxStructure);
  });

  it("collapses past the cap into a +n more row that names the hidden tools", async () => {
    const model = live({
      tools: [
        tool("gmail", "list threads", 0),
        tool("calendar", "freebusy", 1),
        tool("notion", "search", 2),
        tool("github", "list prs", 3),
        tool("drive", "list files", 0),
        tool("slack", "list channels", 1),
      ],
      reservedRows: LIVE_ZONE_MAX_ROWS,
    });
    const rows = liveRows(model, { width: WIDTH, height: HEIGHT });
    expect(rows).toHaveLength(LIVE_ZONE_MAX_ROWS);

    const { height, frame } = await bandHeight(model);
    expect(height).toBe(LIVE_ZONE_MAX_ROWS);
    expect(frame).toContain("+2 more");
    // Named, with a reason, rather than silently dropped.
    expect(frame).toContain("drive, slack");
  });

  it("also names tools the adapter already collapsed", () => {
    const model = live({
      tools: [tool("gmail", "list threads", 0)],
      hiddenTools: ["drive", "slack", "notion"],
    });
    const rows = liveRows(model, { width: WIDTH, height: HEIGHT });
    const text = rows.map((row) => row.segments.map((segment) => segment.text).join("")).join("\n");
    expect(text).toContain("+3 more");
    expect(text).toContain("drive, slack, notion");
  });

  it("occupies exactly the rows reserved, wasting none on a single tool", async () => {
    const { height, frame } = await bandHeight(
      live({ tools: [tool("gmail", "list threads", 0)], reservedRows: 1 }),
    );
    expect(height).toBe(1);
    // The one row is the tool, sitting directly above the input.
    expect(rowsOf(frame)[HEIGHT - 2]).toContain("gmail");
  });

  /**
   * The mid-turn case, and the whole point of the reservation: three tools were
   * running, two finished. The band holds the height it grew to, so the input
   * does not walk up under the user's hands and then back down again.
   */
  it("holds a reservation the content no longer fills, bottom-anchored", async () => {
    const { height, frame } = await bandHeight(
      live({ tools: [tool("gmail", "list threads", 0)], reservedRows: 3 }),
    );
    expect(height).toBe(3);

    const rows = rowsOf(frame);
    // Last band row is the survivor; the two held rows above it are blank.
    expect(rows[HEIGHT - 2]).toContain("gmail");
    expect(rows[HEIGHT - 3]?.trim()).toBe("");
    expect(rows[HEIGHT - 4]?.trim()).toBe("");
  });

  it("gives the rows back once the run settles", async () => {
    const { height, frame } = await bandHeight(
      live({ tools: [tool("gmail", "list threads", 0)], reservedRows: 0 }),
    );
    expect(height).toBe(0);
    expect(frame).not.toContain("gmail");
    expect(rowsOf(frame)[HEIGHT - 2]).toContain("TOP");
  });

  it("never grows past the cap, however high the water rose", async () => {
    const { height } = await bandHeight(
      live({ tools: [tool("gmail", "list threads", 0)], reservedRows: 40 }),
    );
    expect(height).toBe(LIVE_ZONE_MAX_ROWS);
  });

  it("gives two tools at different phases different indicator cells in one frame", async () => {
    const model = live({
      tools: [tool("gmail", "list threads", 0), tool("calendar", "freebusy", 1)],
    });
    const { frame } = await bandHeight(model);
    const rows = rowsOf(frame);
    const first = rows.find((row) => row.includes("gmail"));
    const second = rows.find((row) => row.includes("calendar"));
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // The spinner sits one column past the rail gutter on every tool row.
    const spinnerColumn = [...`${glyphs.rail} `].length;
    expect([...(first as string)][spinnerColumn]).not.toBe([...(second as string)][spinnerColumn]);
  });

  it("animates from a tick argument without rewriting the LiveModel", () => {
    const model = live({ tools: [tool("gmail", "list threads", 0)] });
    const viewport = { width: WIDTH, height: HEIGHT };
    const atZero = liveRows(model, viewport, false, glyphs, LIVE_ZONE_MAX_ROWS, 0);
    const atOne = liveRows(model, viewport, false, glyphs, LIVE_ZONE_MAX_ROWS, 1);
    expect(atOne).not.toEqual(atZero);
    expect(liveRows(model, viewport, false, glyphs, LIVE_ZONE_MAX_ROWS, 0)).toEqual(atZero);
  });

  it("shows the step line as one row while a plan is active, and not otherwise", () => {
    const withStep = liveRows(
      live({
        tools: [tool("gmail", "list threads", 0)],
        step: { index: 3, total: 7, label: "rank by urgency" },
      }),
      { width: WIDTH, height: HEIGHT },
    );
    const text = withStep.map((row) => row.segments.map((segment) => segment.text).join(""));
    expect(text.filter((row) => row.includes("step 3 of 7"))).toHaveLength(1);
    expect(text.some((row) => row.includes("rank by urgency"))).toBe(true);
    expect(text.some((row) => row.includes("1 running"))).toBe(true);

    const withoutStep = liveRows(live({ tools: [tool("gmail", "list threads", 0)] }), {
      width: WIDTH,
      height: HEIGHT,
    });
    expect(withoutStep.some((row) => row.key === "step")).toBe(false);
  });

  it("drops the waiting copy — and its animation — once prose is streaming", async () => {
    const waiting = "reading your calendar before it answers";
    const model = live({ waiting, elapsedMs: 12_000 });

    const before = await bandHeight(model);
    expect(before.frame).toContain(waiting);
    expect(before.frame).toContain("12s");

    const after = await bandHeight(model, { streaming: true });
    expect(after.frame).not.toContain(waiting);

    // The adapter clearing `waiting` says the same thing, and the zone empties.
    const cleared = liveRows(live(), { width: WIDTH, height: HEIGHT });
    expect(cleared).toHaveLength(0);
  });

  it("shows the reasoning clock on the waiting row while a reasoning region is open", () => {
    const model = live({
      waiting: "thinking it through",
      elapsedMs: 45_000,
      reasoningElapsedMs: 7_000,
    });
    const [row] = liveRows(model, { width: WIDTH, height: HEIGHT });
    const text = row?.segments.map((segment) => segment.text).join("") ?? "";
    expect(text).toContain("7s");
    expect(text).not.toContain("45s");
  });

  it("paints the live indicator in the accent, not in whatever the terminal defaults to", async () => {
    const { renderer, renderOnce, captureSpans } = await testRender(
      <LiveZone
        model={live({ tools: [tool("gmail", "list threads", 0)] })}
        viewport={{ width: WIDTH, height: HEIGHT }}
      />,
      { width: WIDTH, height: LIVE_ZONE_MAX_ROWS },
    );
    await renderOnce();
    const captured = captureSpans();
    renderer.destroy();

    const accent = RGBA.fromHex(THEME.primary).toInts().slice(0, 3);
    const painted = captured.lines
      .flatMap((line) => line.spans)
      .some((span) => {
        const ints = span.fg.toInts().slice(0, 3);
        return ints[0] === accent[0] && ints[1] === accent[1] && ints[2] === accent[2];
      });
    expect(painted).toBe(true);
  });

  it("never exceeds the width, and still caps its height, at the minimum width", async () => {
    const model = live({
      tools: [
        tool("calendar", "freebusy 2026-08-20T09:00 through 2026-08-27T18:00", 0, 61_000),
        tool("gmail", "list threads in:inbox newer_than:2d -category:promotions", 1),
        tool("notion", "search across every database in the workspace", 2),
        tool("github", "list prs", 3),
        tool("drive", "list files", 0),
      ],
      step: { index: 3, total: 7, label: "rank the whole inbox by urgency and then by sender" },
      waiting: "reading your calendar before it answers",
      elapsedMs: 5000,
    });

    for (const row of liveRows(model, { width: MIN_WIDTH, height: HEIGHT })) {
      const width = row.segments.reduce(
        (total, segment) => total + terminalCellWidth(segment.text),
        0,
      );
      expect(width).toBeLessThanOrEqual(MIN_WIDTH);
    }

    const { height, frame } = await bandHeight(model, { width: MIN_WIDTH });
    expect(height).toBe(LIVE_ZONE_MAX_ROWS);
    for (const row of rowsOf(frame)) expect(terminalCellWidth(row)).toBe(MIN_WIDTH);
  });

  it("renders the todo checklist as a windowed panel, leading with the active item", async () => {
    const todos: TodoSnapshotItem[] = [
      { content: "first", status: "completed" },
      { content: "active", status: "in_progress" },
      { content: "third", status: "pending" },
      { content: "fourth", status: "pending" },
      { content: "fifth", status: "pending" },
      { content: "sixth", status: "pending" },
      { content: "seventh", status: "pending" },
    ];
    const model = live({ todoList: todos, reservedRows: LIVE_ZONE_MAX_ROWS });
    const { height, frame } = await bandHeight(model, { width: WIDTH });
    expect(height).toBe(LIVE_ZONE_MAX_ROWS);
    expect(frame).toContain("todo 1/7");
    expect(frame).toContain("active");
    // Windowed: not every item fits the 5-row band, so an overflow line appears.
    expect(frame).toContain("+");
    // The step row is suppressed in favour of the checklist.
    expect(frame).not.toContain("step");
  });

  it("shows the whole checklist when it fits the band", async () => {
    const todos: TodoSnapshotItem[] = [
      { content: "one", status: "completed" },
      { content: "two", status: "in_progress" },
      { content: "three", status: "pending" },
    ];
    const model = live({ todoList: todos, reservedRows: 5 });
    const { frame } = await bandHeight(model, { width: WIDTH });
    expect(frame).toContain("one");
    expect(frame).toContain("two");
    expect(frame).toContain("three");
    expect(frame).not.toContain("+");
  });
});

/** Whether any cell in the painted composer carries the accent as a background. */
async function caretPainted(model: InputModel): Promise<boolean> {
  const { renderer, renderOnce, captureSpans } = await testRender(
    <Input
      model={model}
      viewport={{ width: WIDTH, height: HEIGHT }}
    />,
    { width: WIDTH, height: 2 },
  );
  await renderOnce();
  const captured = captureSpans();
  renderer.destroy();

  const accent = RGBA.fromHex(THEME.prompt).toInts().slice(0, 3);
  return captured.lines
    .flatMap((line) => line.spans)
    .some((span) => {
      const ints = span.bg.toInts().slice(0, 3);
      return ints[0] === accent[0] && ints[1] === accent[1] && ints[2] === accent[2];
    });
}

describe("input", () => {
  const base: InputModel = {
    value: "",
    placeholder: "ask jazz anything",
    queued: [],
    disabled: false,
  };

  it("lists slash commands above the composer and marks the selection", () => {
    const rows = inputRows(
      {
        ...base,
        value: "/",
        commands: {
          items: [
            { name: "help", description: "Show available commands", usage: "[command]" },
            { name: "clear", description: "Clear the screen" },
          ],
          selected: 1,
        },
      },
      { width: WIDTH, height: HEIGHT },
    );
    const text = rows.map((row) => row.segments.map((segment) => segment.text).join("")).join("\n");
    expect(text).toContain("/help");
    expect(text).toContain("/clear");
    expect(text).toContain("Clear the screen");
    expect(rows[1]?.segments[0]?.text).toBe(`${glyphs.rail} `);
    expect(rows.at(-1)?.segments[1]?.text).toBe(`${glyphs.promptCursor} `);
  });

  it("wraps the command list as a carousel instead of stopping at the ends", () => {
    expect(wrapCommandIndex(-1, 5)).toBe(4);
    expect(wrapCommandIndex(5, 5)).toBe(0);
    const items = Array.from({ length: 10 }, (_, index) => ({
      name: `cmd-${String(index)}`,
      description: "x",
    }));
    const rows = inputRows(
      { ...base, value: "/", commands: { items, selected: 0 } },
      { width: WIDTH, height: HEIGHT },
    );
    const names = rows
      .slice(0, -1)
      .map((row) => row.segments.map((segment) => segment.text).join(""));
    expect(names[0]).toContain("/cmd-3");
    expect(names.at(-1)).toContain("/cmd-0");
    expect(rows[names.length - 1]?.segments[0]?.text).toBe(`${glyphs.rail} `);
  });

  it("shows one prompt gutter and a caret when the keyboard is live", () => {
    const rows = inputRows(base, { width: WIDTH, height: HEIGHT });
    expect(rows).toHaveLength(1);
    const first = rows[0];
    expect(first?.segments[0]?.text).toBe(`${glyphs.rail} `);
    expect(first?.segments[1]?.text).toBe(`${glyphs.promptCursor} `);
    expect(first?.segments[1]?.fg).toBe(THEME.prompt);
    expect(first?.segments.some((segment) => segment.bg === THEME.prompt)).toBe(true);
  });

  it("shows a dim placeholder and no caret when an overlay owns the keyboard", async () => {
    const disabled = { ...base, disabled: true };
    const rows = inputRows(disabled, { width: WIDTH, height: HEIGHT });
    expect(rows.flatMap((row) => row.segments).some((segment) => segment.bg !== undefined)).toBe(
      false,
    );
    expect(rows[0]?.segments[1]?.fg).toBe(THEME.muted);

    // And the same statement made against the painted frame. The live case is
    // asserted alongside it, because "no accent background anywhere" would pass
    // just as well if the caret were never painted in the first place.
    expect(await caretPainted(base)).toBe(true);
    expect(await caretPainted(disabled)).toBe(false);
  });

  it("keeps a disabled draft visible rather than replacing it with the placeholder", () => {
    const rows = inputRows(
      { ...base, value: "half a thought", disabled: true },
      { width: WIDTH, height: HEIGHT },
    );
    const text = rows.map((row) => row.segments.map((segment) => segment.text).join("")).join("");
    expect(text).toContain("half a thought");
    expect(text).not.toContain(base.placeholder);
  });

  it("grows with content to a cap, then scrolls with a marker naming the hidden lines", () => {
    const short = inputRows(
      { ...base, value: "one\ntwo\nthree" },
      { width: WIDTH, height: HEIGHT },
    );
    expect(short).toHaveLength(3);

    const long = inputRows(
      { ...base, value: Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n") },
      { width: WIDTH, height: HEIGHT },
    );
    expect(long).toHaveLength(INPUT_MAX_ROWS_EXPECTED);
    const marker = long[0]?.segments.map((segment) => segment.text).join("") ?? "";
    expect(marker).toContain(`${glyphs.railDeep} 7 more lines`);
    // The caret stays visible: the window ends at the last line, not the first.
    expect(
      long[long.length - 1]?.segments.some((segment) => segment.text.includes("line 11")),
    ).toBe(true);
  });

  it("lists queued messages below the count", () => {
    const none = inputRows(base, { width: WIDTH, height: HEIGHT });
    expect(none.map((row) => row.segments.map((s) => s.text).join("")).join("")).not.toContain(
      "queued",
    );

    const some = inputRows(
      { ...base, queued: ["follow up", "send the itinerary"] },
      { width: WIDTH, height: HEIGHT },
    );
    const text = some.map((row) => row.segments.map((s) => s.text).join("")).join("\n");
    expect(text).toContain("2 queued");
    expect(text).toContain("follow up");
    expect(text).toContain("send the itinerary");
    expect(text.indexOf("2 queued")).toBeLessThan(text.indexOf("follow up"));
    expect(text.indexOf("follow up")).toBeLessThan(text.indexOf("send the itinerary"));
    expect(text.indexOf("send the itinerary")).toBeLessThan(text.indexOf("ask jazz"));
    expect(some).toHaveLength(4);
  });

  it("keeps the newest queued messages when the queue is longer than the cap", () => {
    const queued = ["one", "two", "three", "four"];
    const some = inputRows({ ...base, queued }, { width: WIDTH, height: HEIGHT });
    const text = some.map((row) => row.segments.map((s) => s.text).join("")).join("\n");
    expect(text).toContain("4 queued");
    expect(text).not.toContain(`${glyphs.bullet} one`);
    expect(text).toContain("two");
    expect(text).toContain("three");
    expect(text).toContain("four");
    expect(some).toHaveLength(2 + MAX_VISIBLE_QUEUED);
  });

  it("collapses queued newlines and warns when a slash command is mixed in", () => {
    const some = inputRows(
      { ...base, queued: ["/clear", "keep going"] },
      { width: WIDTH, height: HEIGHT },
    );
    const text = some.map((row) => row.segments.map((s) => s.text).join("")).join("\n");
    expect(text).toContain("/clear");
    expect(text).toContain("sent as text, not run");
    expect(text).toContain("keep going");

    const wrapped = inputRows(
      { ...base, queued: ["first line\nsecond line"] },
      { width: WIDTH, height: HEIGHT },
    );
    const wrappedText = wrapped.map((row) => row.segments.map((s) => s.text).join("")).join("\n");
    expect(wrappedText).toContain("first line second line");
    expect(wrappedText).not.toContain("first line\nsecond line");
  });

  it("drops queued previews before the count when the shell is squeezed", () => {
    const squeezed = inputRows(
      { ...base, queued: ["follow up", "send the itinerary"] },
      { width: WIDTH, height: HEIGHT },
      true,
      glyphs,
      2,
    );
    const text = squeezed.map((row) => row.segments.map((s) => s.text).join("")).join("\n");
    expect(text).toContain("2 queued");
    expect(text).not.toContain("follow up");
    expect(squeezed).toHaveLength(2);
  });

  it("never exceeds the width at the minimum width, caret included", () => {
    const value = "a".repeat(400);
    const queued = ["one", "two", "three", "four"];
    const models = [
      { ...base, value },
      { ...base, value: "b".repeat(MIN_WIDTH - 2) },
      { ...base, value, queued },
      { ...base, placeholder: "x".repeat(200) },
      { ...base, disabled: true, placeholder: "x".repeat(200) },
    ];
    for (const model of models) {
      const rows = inputRows(model, { width: MIN_WIDTH, height: HEIGHT });
      const queuedRows = model.queued.length === 0 ? 0 : MAX_VISIBLE_QUEUED;
      expect(rows.length).toBeLessThanOrEqual(INPUT_MAX_ROWS_EXPECTED + queuedRows);
      for (const row of rows) {
        const width = row.segments.reduce(
          (total, segment) => total + terminalCellWidth(segment.text),
          0,
        );
        expect(width).toBeLessThanOrEqual(MIN_WIDTH);
      }
    }
  });

  it("paints a selection as a surface wash between anchor and caret", () => {
    const rows = inputRows(
      { ...base, value: "hello world", caret: 11, anchor: 6 },
      { width: WIDTH, height: HEIGHT },
    );
    const selected = rows
      .flatMap((row) => row.segments)
      .filter((segment) => segment.bg === THEME.surfaceStrong)
      .map((segment) => segment.text)
      .join("");
    expect(selected).toBe("world");
  });
});
