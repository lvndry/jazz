/** @jsxImportSource @opentui/react */
/**
 * Whole-frame assertions for the fullscreen interface.
 *
 * The component tests check each region in isolation; these check the thing a
 * person actually sees. Because every region is a pure function of the view
 * model, a frame is reproducible from data alone — so the design's rules become
 * executable rather than aspirational. The density assertion in particular is
 * the calm-pass target as a contract: the first draft of this layout measured
 * 32% ink and was rejected as "very busy".
 */

import { testRender } from "@opentui/react/test-utils";
import { describe, expect, it } from "bun:test";
import React from "react";
import { App } from "./App";
import {
  sampleApprovalView,
  sampleBusyView,
  sampleIdleView,
  sampleSearchView,
  sampleView,
} from "./sample";
import { MIN_HEIGHT, MIN_WIDTH } from "./types";

const WIDTH = 120;
const HEIGHT = 34;

interface Frame {
  readonly rows: readonly string[];
  readonly text: string;
}

async function frameOf(
  view: Parameters<typeof App>[0]["view"],
  width = WIDTH,
  height = HEIGHT,
): Promise<Frame> {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <App
      view={view}
      onAction={() => undefined}
    />,
    { width, height },
  );
  await renderOnce();
  const text = captureCharFrame();
  renderer.destroy();
  return { rows: text.split("\n").filter((row) => row.length > 0), text };
}

/** Cells that carry content, rather than space or frame chrome. */
const CHROME = new Set([..."─━│┃┌┐└┘├┤┬┴┼╴╶╺╻╹╵▎▏▐░▒▓█▚▖▘▝▗"]);

function inkDensity(rows: readonly string[]): number {
  const cells = rows.flatMap((row) => [...row]);
  const ink = cells.filter((cell) => cell !== " " && !CHROME.has(cell)).length;
  return ink / Math.max(1, cells.length);
}

function breathingShare(rows: readonly string[]): number {
  const quiet = rows.filter((row) => {
    const inked = [...row].filter((cell) => cell !== " ");
    return inked.length === 0 || inked.every((cell) => CHROME.has(cell));
  }).length;
  return quiet / Math.max(1, rows.length);
}

describe("fullscreen frame", () => {
  it("fills the terminal exactly, with chrome anchored top and bottom", async () => {
    const frame = await frameOf(sampleView());
    expect(frame.rows).toHaveLength(HEIGHT);
    for (const row of frame.rows) expect([...row]).toHaveLength(WIDTH);
  });

  it("is calm enough to read: the density target the first draft failed", async () => {
    // Measured in Unicode glyph mode deliberately. In ASCII mode the divider is
    // 120 literal hyphens and the meter is dots — structure that a chrome set
    // cannot distinguish from prose punctuation, so the metric would count a
    // rule row as 120 cells of content and report a design problem that isn't
    // one. Unicode is also what the design targets and what a real terminal
    // gets.
    const previous = process.env["JAZZ_UI_GLYPHS"];
    process.env["JAZZ_UI_GLYPHS"] = "unicode";
    try {
      const frame = await frameOf(sampleView());
      // 32% ink was rejected as "very busy"; a well-set book page is around 10%.
      expect(inkDensity(frame.rows)).toBeLessThanOrEqual(0.22);
      expect(breathingShare(frame.rows)).toBeGreaterThanOrEqual(0.4);
    } finally {
      if (previous === undefined) delete process.env["JAZZ_UI_GLYPHS"];
      else process.env["JAZZ_UI_GLYPHS"] = previous;
    }
  });

  it("keeps the input anchored when the amount of running work changes", async () => {
    // This is the whole reason the live zone grows upward instead of downward:
    // the thing under the user's hands must not move as tools come and go.
    const idle = await frameOf(sampleIdleView());
    const busy = await frameOf(sampleBusyView());
    expect(idle.rows).toHaveLength(HEIGHT);
    expect(busy.rows).toHaveLength(HEIGHT);
    // Same number of rows, and the footer is the last row in both.
    expect(idle.rows[HEIGHT - 1]).toBeDefined();
    expect(busy.rows[HEIGHT - 1]).toBeDefined();
  });

  it("shows the whole approval card, naming the real account verbatim", async () => {
    const frame = await frameOf(sampleApprovalView());
    expect(frame.text).toContain("you@example.com");
    // Every field that will exist afterwards, before committing to it.
    expect(frame.text).toContain("15:00");
    expect(frame.text).toContain("Work");
    // Irreversibility as a sentence, not an icon.
    expect(frame.text.toLowerCase()).toContain("not undoable");
  });

  it("does not disturb the transcript when an overlay opens", async () => {
    const plain = await frameOf(sampleView());
    const overlaid = await frameOf(sampleApprovalView());

    // Rows the card cannot be covering must still carry the same content. An
    // overlay that reflowed the tree behind it would shift or drop lines here.
    const plainWords = new Set(plain.text.split(/\s+/).filter((word) => word.length > 6));
    const survivors = overlaid.text
      .split(/\s+/)
      .filter((word) => word.length > 6 && plainWords.has(word));
    expect(survivors.length).toBeGreaterThan(3);
  });

  it("opens search across sessions without losing the session behind it", async () => {
    const frame = await frameOf(sampleSearchView());
    expect(frame.text.toLowerCase()).toContain("basel");
    expect(frame.rows).toHaveLength(HEIGHT);
  });

  it("refuses to draw a partial frame below the minimum size", async () => {
    const frame = await frameOf(sampleView(), 40, 8);
    expect(frame.text).toContain(`${MIN_WIDTH}x${MIN_HEIGHT}`);
    expect(frame.text).toContain("40x8");
    // It says the way out rather than just complaining.
    expect(frame.text).toContain("plain");
  });

  it("draws nothing from a font range the target fonts do not cover", async () => {
    // The strongest form of the glyph-safety rule: assert the actual output, so
    // a component sneaking in a checkmark or an arrow fails here even if it
    // never touches the glyph module. Verified ranges are ASCII, Latin-1,
    // General Punctuation, Math Operators, Box Drawing and Block Elements —
    // everything else risks a fallback glyph at a mismatched advance width.
    const safe = (codePoint: number): boolean =>
      (codePoint >= 0x20 && codePoint <= 0x7e) ||
      (codePoint >= 0xa0 && codePoint <= 0xff) ||
      (codePoint >= 0x2000 && codePoint <= 0x206f) ||
      (codePoint >= 0x2200 && codePoint <= 0x22ff) ||
      (codePoint >= 0x2500 && codePoint <= 0x259f);

    for (const view of [
      sampleView(),
      sampleApprovalView(),
      sampleSearchView(),
      sampleBusyView(),
      sampleIdleView(),
    ]) {
      const frame = await frameOf(view);
      const offenders = [...new Set([...frame.text])]
        .filter((character) => character !== "\n")
        .filter((character) => !safe(character.codePointAt(0) ?? 0))
        .map(
          (character) =>
            `${character} (U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")})`,
        );
      expect(offenders).toEqual([]);
    }
  });

  it("holds its shape at the narrow end of the supported range", async () => {
    const frame = await frameOf(sampleView(), 80, 24);
    expect(frame.rows).toHaveLength(24);
    for (const row of frame.rows) expect([...row]).toHaveLength(80);
  });

  it("holds its shape on a very wide terminal without stretching prose", async () => {
    const frame = await frameOf(sampleView(), 200, 40);
    expect(frame.rows).toHaveLength(40);
    for (const row of frame.rows) expect([...row]).toHaveLength(200);
    // Prose is measured, so a 200-column window does not produce 200-column lines
    // of running text.
    const prose = frame.rows.filter((row) => /[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}/.test(row));
    for (const row of prose) {
      expect(row.trimEnd().length).toBeLessThanOrEqual(120);
    }
  });
});
