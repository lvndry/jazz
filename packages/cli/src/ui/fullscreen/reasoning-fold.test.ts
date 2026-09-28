import { beforeAll, describe, expect, it } from "bun:test";
import { getGlyphs } from "../glyphs";
import { setThemeVariant } from "../theme";
import { foldTurnReasoning } from "./reasoning-fold";
import { LIVE_REASONING_LINES, transcriptRows, type RenderRow } from "./Transcript";
import type { Block } from "./types";

const VIEWPORT = { width: 120, height: 40 };

function text(row: RenderRow | undefined): string {
  return row?.content.map((segment) => segment.text).join("") ?? "";
}

describe("one folded reasoning line per turn", () => {
  it("folds a turn's reasoning into its first block, adding durations and steps", () => {
    const blocks: Block[] = [
      { id: "u", seq: 0, kind: "user", text: "plan my week" },
      { id: "r1", seq: 1, kind: "reasoning", text: "", collapsed: true, durationMs: 1_500 },
      { id: "t", seq: 2, kind: "tool", app: "gmail", summary: "4 flagged", status: "ok" },
      { id: "r2", seq: 3, kind: "reasoning", text: "", collapsed: true, durationMs: 2_600 },
      { id: "a", seq: 4, kind: "agent", markdown: "Here is the plan." },
    ];
    const folded = foldTurnReasoning(blocks);
    expect(folded.map((block) => block.id)).toEqual(["u", "r1", "t", "a"]);
    const reasoning = folded[1];
    expect(reasoning?.kind === "reasoning" ? [reasoning.durationMs, reasoning.steps] : []).toEqual([
      4_100, 2,
    ]);
  });

  it("starts a new line for each turn", () => {
    const blocks: Block[] = [
      { id: "u1", seq: 0, kind: "user", text: "one" },
      { id: "r1", seq: 1, kind: "reasoning", text: "", collapsed: true, durationMs: 1_000 },
      { id: "u2", seq: 2, kind: "user", text: "two" },
      { id: "r2", seq: 3, kind: "reasoning", text: "", collapsed: true, durationMs: 2_000 },
    ];
    expect(foldTurnReasoning(blocks).map((block) => block.id)).toEqual(["u1", "r1", "u2", "r2"]);
  });

  it("leaves reasoning the reader opened, and live reasoning, in place", () => {
    const blocks: Block[] = [
      { id: "r1", seq: 0, kind: "reasoning", text: "", collapsed: true, durationMs: 1_000 },
      { id: "r2", seq: 1, kind: "reasoning", text: "opened", collapsed: false, durationMs: 2_000 },
      { id: "r3", seq: 2, kind: "reasoning", text: "now", collapsed: false, live: true },
    ];
    expect(foldTurnReasoning(blocks).map((block) => block.id)).toEqual(["r1", "r2", "r3"]);
  });
});

describe("reasoning rows", () => {
  beforeAll(() => {
    setThemeVariant("dark");
  });

  it("shows only the newest lines, italic, under a thinking label while live", () => {
    const lines = Array.from({ length: 8 }, (_, index) => `line ${String(index + 1)} of thought`);
    const rows = transcriptRows(
      [
        {
          id: "r",
          seq: 0,
          kind: "reasoning",
          text: lines.join("\n"),
          collapsed: false,
          live: true,
        },
      ],
      VIEWPORT,
    );
    expect(text(rows[0]).trim()).toBe("thinking");
    expect(rows[0]?.content.some((segment) => segment.italic === true)).toBe(true);
    const body = rows.slice(1).map((row) => text(row));
    expect(body).toHaveLength(LIVE_REASONING_LINES);
    expect(body.at(-1)).toContain("line 8 of thought");
    expect(body[0]).toContain(getGlyphs().railDeep);
    expect(rows[1]?.content.some((segment) => segment.italic === true)).toBe(true);
  });

  it("opens to the full text with a fold hint", () => {
    const rows = transcriptRows(
      [
        {
          id: "r",
          seq: 0,
          kind: "reasoning",
          text: "first\nsecond\nthird\nfourth",
          collapsed: false,
          durationMs: 4_100,
        },
      ],
      VIEWPORT,
    );
    expect(text(rows[0])).toContain(`${getGlyphs().unfolded} thought for 4.1s`);
    expect(rows.map((row) => text(row)).join("\n")).toContain("fourth");
    expect(text(rows.at(-1))).toContain("ctrl+r to fold");
  });
});
