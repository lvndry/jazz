/** @jsxImportSource @opentui/react */

/**
 * The overlays are asserted on the composited output rather than on a React
 * tree, because the design claims are claims about characters and attributes:
 * which account name is on screen, whether the accept key is bold, whether a
 * match is marked by something other than a colour.
 *
 * `captureSpans()` carries the real per-span foreground, which the rest of the
 * suite cannot see — those tests run with colour off. So the colour law is
 * enforced here or nowhere.
 */

import { TextAttributes, type CapturedFrame, type CapturedSpan } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { getGlyphs } from "../../glyphs";
import { THEME } from "../../theme";
import type { ApprovalOverlay, SearchOverlay, Viewport } from "../types";
import { Approval } from "./Approval";
import { Search } from "./Search";

const WIDE: Viewport = { width: 120, height: 34 };
const NARROW: Viewport = { width: 70, height: 18 };

/**
 * U+2550–U+2570: the double-line box drawing family and the four rounded
 * corners. Terminals do not draw these procedurally and they are the most
 * fallback-prone glyphs in the range, so no frame may contain one.
 */
const FORBIDDEN_BOX = /[═-╰]/;

const APPROVAL: ApprovalOverlay = {
  kind: "approval",
  app: "Gmail",
  action: "Send email",
  account: "landry@example.com",
  fields: [
    { label: "To", value: "alice@example.com" },
    { label: "Cc", value: "bob@example.com" },
    { label: "Subject", value: "Q3 numbers" },
    { label: "Body", value: "Here are the numbers you asked for." },
  ],
  consequence: "Once this is sent it cannot be unsent.",
  armed: false,
};

const SEARCH: SearchOverlay = {
  kind: "search",
  query: "deploy",
  scope: "all",
  hits: [
    {
      sessionId: "s1",
      sessionTitle: "Shipping 0.14",
      when: "12 min ago",
      line: "the deploy notes live in docs",
      matchStart: 4,
      matchLength: 6,
      current: true,
    },
    {
      sessionId: "s2",
      sessionTitle: "Weekend planning",
      when: "3 days ago",
      line: "remember to deploy before the demo",
      matchStart: 12,
      matchLength: 6,
      current: false,
    },
    {
      sessionId: "s3",
      sessionTitle: "Calendar cleanup",
      when: "2 weeks ago",
      line: "no deploy window on friday",
      matchStart: 3,
      matchLength: 6,
      current: false,
    },
  ],
  selected: 1,
};

function rows(frame: string): string[] {
  return frame.split("\n").filter((row) => row.length > 0);
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

function themeHex(color: string): string {
  return color.toUpperCase();
}

function spanWithText(frame: CapturedFrame, text: string): CapturedSpan {
  const found = allSpans(frame).find((span) => span.text === text);
  if (found === undefined) {
    throw new Error(`no span with exact text ${JSON.stringify(text)}`);
  }
  return found;
}

/** Rows on which at least one span carries the given foreground. */
function rowsColored(frame: CapturedFrame, color: string): number[] {
  const wanted = themeHex(color);
  return frame.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) =>
      line.spans.some((span) => span.text.trim().length > 0 && hexOf(span) === wanted),
    )
    .map(({ index }) => index);
}

/** Perceived brightness, for asserting that one affordance is dimmer than another. */
function luminance(span: CapturedSpan): number {
  const [red, green, blue] = span.fg.toInts();
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Indices of the rows a bordered frame occupies. */
function framedRows(frame: string): number[] {
  const glyphs = getGlyphs();
  return rows(frame)
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.includes(glyphs.boxV) || row.includes(glyphs.boxTL))
    .map(({ index }) => index);
}

async function draw(node: ReactNode, viewport: Viewport) {
  const setup = await testRender(node, { width: viewport.width, height: viewport.height });
  await setup.renderOnce();
  return setup;
}

describe("approval overlay", () => {
  it("names the account and every field before anything is committed", async () => {
    const { renderer, captureCharFrame } = await draw(
      <Approval
        model={APPROVAL}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureCharFrame();

    expect(frame).toContain(APPROVAL.account);
    for (const field of APPROVAL.fields) {
      expect(frame).toContain(field.label);
      expect(frame).toContain(field.value);
    }
    expect(frame).toContain(APPROVAL.consequence);
    expect(frame).toContain(APPROVAL.action);
    expect(frame).toContain(APPROVAL.app);

    renderer.destroy();
  });

  it("never paints the card in error red, and spends the warning hue on one row", async () => {
    const { renderer, captureSpans } = await draw(
      <Approval
        model={APPROVAL}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureSpans();

    for (const span of allSpans(frame)) {
      if (span.text.trim().length === 0) continue;
      expect(hexOf(span)).not.toBe(themeHex(THEME.error));
    }

    // The marker and the verb, and nothing else.
    expect(rowsColored(frame, THEME.warning)).toHaveLength(1);

    renderer.destroy();
  });

  it("renders accept inert while the arming delay has not passed, with reject live beside it", async () => {
    const { renderer, captureSpans } = await draw(
      <Approval
        model={APPROVAL}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureSpans();

    const accept = spanWithText(frame, "enter");
    expect(accept.attributes & TextAttributes.BOLD).toBe(0);
    expect(accept.attributes & TextAttributes.DIM).not.toBe(0);
    expect(hexOf(accept)).toBe(themeHex(THEME.secondary));

    const reject = spanWithText(frame, "esc");
    expect(reject.attributes & TextAttributes.BOLD).not.toBe(0);
    expect(hexOf(reject)).toBe(themeHex(THEME.selected));

    renderer.destroy();
  });

  it("arms accept without changing reject", async () => {
    const { renderer, captureSpans } = await draw(
      <Approval
        model={{ ...APPROVAL, armed: true }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureSpans();

    const accept = spanWithText(frame, "enter");
    expect(accept.attributes & TextAttributes.BOLD).not.toBe(0);
    expect(hexOf(accept)).toBe(themeHex(THEME.primary));

    const reject = spanWithText(frame, "esc");
    expect(reject.attributes & TextAttributes.BOLD).not.toBe(0);
    expect(hexOf(reject)).toBe(themeHex(THEME.selected));

    renderer.destroy();
  });

  it("keeps always-allow the least attractive thing on screen", async () => {
    for (const armed of [false, true]) {
      const { renderer, captureSpans } = await draw(
        <Approval
          model={{ ...APPROVAL, armed }}
          viewport={WIDE}
        />,
        WIDE,
      );
      const frame = captureSpans();

      const always = spanWithText(frame, "a always allow");
      expect(always.attributes & TextAttributes.BOLD).toBe(0);
      expect(luminance(always)).toBeLessThan(luminance(spanWithText(frame, "enter")));
      expect(luminance(always)).toBeLessThan(luminance(spanWithText(frame, "esc")));

      renderer.destroy();
    }
  });

  it("puts the controls on a line beneath the data frame", async () => {
    const { renderer, captureCharFrame } = await draw(
      <Approval
        model={APPROVAL}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureCharFrame();
    const lines = rows(frame);

    const controls = lines.findIndex((row) => row.includes("accept"));
    expect(controls).toBeGreaterThan(0);
    expect(lines[controls]).toContain("reject");

    // Every row of the frame is above the controls row, and the controls row
    // itself carries no frame at all.
    for (const index of framedRows(frame)) {
      expect(index).toBeLessThan(controls);
    }
    expect(framedRows(frame)).not.toContain(controls);

    renderer.destroy();
  });

  it("fits the wide viewport exactly and goes fullscreen at the narrow one", async () => {
    const wide = await draw(
      <Approval
        model={APPROVAL}
        viewport={WIDE}
      />,
      WIDE,
    );
    const wideRows = rows(wide.captureCharFrame());
    expect(wideRows).toHaveLength(WIDE.height);
    for (const row of wideRows) expect([...row]).toHaveLength(WIDE.width);
    // Windowed: the panel is inset, so the first column is never painted.
    expect(wideRows.every((row) => (row[0] ?? " ") === " ")).toBe(true);
    wide.renderer.destroy();

    const narrow = await draw(
      <Approval
        model={APPROVAL}
        viewport={NARROW}
      />,
      NARROW,
    );
    const narrowRows = rows(narrow.captureCharFrame());
    expect(narrowRows).toHaveLength(NARROW.height);
    for (const row of narrowRows) expect([...row]).toHaveLength(NARROW.width);
    // Fullscreen: the frame starts at column zero of row zero, and the
    // controls line is the last row of the viewport.
    expect((narrowRows[0] ?? "")[0]).toBe(getGlyphs().boxTL);
    expect(narrowRows[NARROW.height - 1]).toContain("accept");
    narrow.renderer.destroy();
  });
});

describe("search overlay", () => {
  it("shows the query, the scope, the hits, the count and the keys", async () => {
    const { renderer, captureCharFrame } = await draw(
      <Search
        model={SEARCH}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureCharFrame();

    expect(frame).toContain("deploy");
    expect(frame).toContain("all sessions");
    expect(frame).toContain("3 matches");
    expect(frame).toContain("Shipping 0.14");
    expect(frame).toContain("Weekend planning");
    expect(frame).toContain("12 min ago");
    expect(frame).toContain("open");
    expect(frame).toContain("scope");
    expect(frame).toContain("close");

    renderer.destroy();
  });

  it("marks the match with an attribute, not with a colour alone", async () => {
    const { renderer, captureSpans } = await draw(
      <Search
        model={SEARCH}
        viewport={WIDE}
      />,
      WIDE,
    );
    const marked = allSpans(captureSpans()).filter(
      (span) => (span.attributes & (TextAttributes.UNDERLINE | TextAttributes.INVERSE)) !== 0,
    );

    // One marked run per hit, and the marked run is the query text itself.
    expect(marked).toHaveLength(SEARCH.hits.length);
    for (const span of marked) {
      expect(span.text).toBe(SEARCH.query);
    }

    renderer.destroy();
  });

  it("marks the selected hit by weight and the rail", async () => {
    const { renderer, captureSpans } = await draw(
      <Search
        model={SEARCH}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureSpans();

    expect(spanWithText(frame, "Weekend planning").attributes & TextAttributes.BOLD).not.toBe(0);
    expect(spanWithText(frame, "Shipping 0.14").attributes & TextAttributes.BOLD).toBe(0);

    const rails = allSpans(frame).filter(
      (span) => span.text === getGlyphs().rail && hexOf(span) === themeHex(THEME.primary),
    );
    expect(rails).toHaveLength(1);

    renderer.destroy();
  });

  it("tells this session apart from older ones by a glyph, not only a hue", async () => {
    const glyphs = getGlyphs();
    const { renderer, captureCharFrame } = await draw(
      <Search
        model={SEARCH}
        viewport={WIDE}
      />,
      WIDE,
    );
    const lines = rows(captureCharFrame());

    /** The recency marker sits past the frame edge, the pad and the rail column. */
    const markerOf = (title: string): string => {
      const row = lines.find((line) => line.includes(title)) ?? "";
      return row.charAt(row.indexOf(glyphs.boxV) + 3);
    };

    expect(markerOf("Shipping 0.14")).toBe(glyphs.active);
    expect(markerOf("Weekend planning")).toBe(glyphs.pending);
    expect(markerOf("Calendar cleanup")).toBe(glyphs.pending);
    // The glyphs differ, so the distinction survives a monochrome terminal.
    expect(glyphs.active).not.toBe(glyphs.pending);

    renderer.destroy();
  });

  it("says so plainly when nothing matched, without moving the frame", async () => {
    const populated = await draw(
      <Search
        model={SEARCH}
        viewport={WIDE}
      />,
      WIDE,
    );
    const before = framedRows(populated.captureCharFrame());
    populated.renderer.destroy();

    const empty = await draw(
      <Search
        model={{ ...SEARCH, query: "nothing here", hits: [], selected: 0 }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const emptyFrame = empty.captureCharFrame();

    expect(emptyFrame).toContain("No matches for");
    expect(emptyFrame).toContain("no matches");
    expect(framedRows(emptyFrame)).toEqual(before);

    empty.renderer.destroy();
  });

  it("fits the wide viewport exactly and goes fullscreen at the narrow one", async () => {
    const wide = await draw(
      <Search
        model={SEARCH}
        viewport={WIDE}
      />,
      WIDE,
    );
    const wideRows = rows(wide.captureCharFrame());
    expect(wideRows).toHaveLength(WIDE.height);
    for (const row of wideRows) expect([...row]).toHaveLength(WIDE.width);
    expect(wideRows.every((row) => (row[0] ?? " ") === " ")).toBe(true);
    wide.renderer.destroy();

    const narrow = await draw(
      <Search
        model={SEARCH}
        viewport={NARROW}
      />,
      NARROW,
    );
    const narrowRows = rows(narrow.captureCharFrame());
    expect(narrowRows).toHaveLength(NARROW.height);
    for (const row of narrowRows) expect([...row]).toHaveLength(NARROW.width);
    expect((narrowRows[0] ?? "")[0]).toBe(getGlyphs().boxTL);
    expect(narrowRows[NARROW.height - 1]).toContain("open");
    narrow.renderer.destroy();
  });

  it("keeps a long line's match on screen", async () => {
    const line = `${"padding ".repeat(30)}deploy tail`;
    const { renderer, captureSpans } = await draw(
      <Search
        model={{
          ...SEARCH,
          hits: [
            {
              sessionId: "long",
              sessionTitle: "Long line",
              when: "now",
              line,
              matchStart: line.indexOf("deploy"),
              matchLength: 6,
              current: false,
            },
          ],
          selected: 0,
        }}
        viewport={WIDE}
      />,
      WIDE,
    );

    const marked = allSpans(captureSpans()).filter(
      (span) => (span.attributes & TextAttributes.UNDERLINE) !== 0,
    );
    expect(marked).toHaveLength(1);
    expect(marked[0]?.text).toBe("deploy");

    renderer.destroy();
  });
});

describe("overlays in unicode glyph mode", () => {
  const previous = process.env["JAZZ_UI_GLYPHS"];

  beforeAll(() => {
    process.env["JAZZ_UI_GLYPHS"] = "unicode";
  });

  afterAll(() => {
    if (previous === undefined) delete process.env["JAZZ_UI_GLYPHS"];
    else process.env["JAZZ_UI_GLYPHS"] = previous;
  });

  it("frames both overlays in light box drawing, never rounded or double", async () => {
    const glyphs = getGlyphs();

    const approval = await draw(
      <Approval
        model={APPROVAL}
        viewport={WIDE}
      />,
      WIDE,
    );
    const approvalFrame = approval.captureCharFrame();
    expect(approvalFrame).toContain(glyphs.boxTL);
    expect(approvalFrame).toContain(glyphs.boxBR);
    // The marker that means "the agent is asking for authority".
    expect(approvalFrame).toContain(glyphs.proposed);
    expect(FORBIDDEN_BOX.test(approvalFrame)).toBe(false);
    approval.renderer.destroy();

    const search = await draw(
      <Search
        model={SEARCH}
        viewport={WIDE}
      />,
      WIDE,
    );
    const searchFrame = search.captureCharFrame();
    expect(searchFrame).toContain(glyphs.boxTL);
    expect(searchFrame).toContain(glyphs.rail);
    expect(FORBIDDEN_BOX.test(searchFrame)).toBe(false);
    search.renderer.destroy();
  });
});
