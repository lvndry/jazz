import { beforeAll, describe, expect, it } from "bun:test";
import { getGlyphs } from "../glyphs";
import { setThemeVariant } from "../theme";
import { LIVE_REASONING_LINES, transcriptRows, type RenderRow } from "./Transcript";
import { foldTurn } from "./turn-fold";
import type { Block } from "./types";

const VIEWPORT = { width: 120, height: 40 };

function text(row: RenderRow | undefined): string {
  return row?.content.map((segment) => segment.text).join("") ?? "";
}

describe("one plan receipt per turn", () => {
  const update = (id: string, seq: number, summary: string): Block => ({
    id,
    seq,
    kind: "tool",
    app: "manage_todos",
    args: '{"todos":[...]}',
    summary,
    status: "ok",
  });

  it("keeps only the last plan update, where it happened, under the name plan", () => {
    const blocks: Block[] = [
      { id: "u", seq: 0, kind: "user", text: "sort Saturday" },
      update("p1", 1, "0 of 3 done"),
      { id: "t", seq: 2, kind: "tool", app: "gmail", summary: "6 messages", status: "ok" },
      update("p2", 3, "2 of 3 done"),
      { id: "a", seq: 4, kind: "agent", markdown: "Done." },
      update("p3", 5, "3 of 3 done"),
    ];
    const folded = foldTurn(blocks);
    expect(folded.map((block) => block.id)).toEqual(["u", "t", "a", "p3"]);
    const plan = folded.at(-1);
    expect(plan?.kind === "tool" ? [plan.app, plan.summary, plan.args] : []).toEqual([
      "plan",
      "3 of 3 done",
      undefined,
    ]);
  });

  it("keeps a failed plan update, since it says something went wrong", () => {
    const blocks: Block[] = [
      { id: "p1", seq: 0, kind: "tool", app: "manage_todos", summary: "", status: "failed" },
      update("p2", 1, "1 of 2 done"),
    ];
    expect(foldTurn(blocks).map((block) => block.id)).toEqual(["p1", "p2"]);
  });
});

describe("reasoning rows", () => {
  beforeAll(() => {
    setThemeVariant("dark");
  });

  it("shows only the newest lines, italic, and leaves the label to the live zone", () => {
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
    const body = rows.map((row) => text(row));
    expect(body).toHaveLength(LIVE_REASONING_LINES);
    expect(body.at(-1)).toContain("line 8 of thought");
    expect(body[0]).toContain(getGlyphs().railDeep);
    expect(body.join("\n")).not.toContain("thinking");
    expect(rows[0]?.content.some((segment) => segment.italic === true)).toBe(true);
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
