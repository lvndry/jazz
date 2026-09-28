import { beforeAll, describe, expect, it } from "bun:test";
import { getGlyphs } from "../glyphs";
import { setThemeVariant, THEME } from "../theme";
import { liveRows, type LiveRow, type LiveSegment } from "./LiveZone";
import type { LiveModel } from "./types";

const VIEWPORT = { width: 80, height: 24 };

function plan(): LiveModel {
  return {
    tools: [],
    hiddenTools: [],
    reservedRows: 6,
    todoList: [
      { content: "read the venue thread", status: "completed" },
      { content: "compare the three venues", status: "in_progress" },
      { content: "draft the reply to Dana", status: "pending" },
    ],
  };
}

function itemSegment(rows: readonly LiveRow[], content: string): LiveSegment | undefined {
  return rows.flatMap((row) => row.segments).find((segment) => segment.text === content);
}

describe("the plan in the live zone", () => {
  beforeAll(() => {
    setThemeVariant("dark");
  });

  it("heads the plan with its progress", () => {
    const rows = liveRows(plan(), VIEWPORT);
    const header = rows[0]?.segments.map((segment) => segment.text).join("") ?? "";
    expect(header).toContain("plan");
    expect(header.trimEnd()).toEndWith("1 of 3");
  });

  it("strikes through what is done, holds the current step in bold, and keeps what is next quiet", () => {
    const rows = liveRows(plan(), VIEWPORT);
    const done = itemSegment(rows, "read the venue thread");
    const current = itemSegment(rows, "compare the three venues");
    const next = itemSegment(rows, "draft the reply to Dana");
    expect(done?.strikethrough).toBe(true);
    expect(done?.fg).toBe(THEME.muted);
    expect(current?.bold).toBe(true);
    expect(current?.fg).toBe(THEME.selected);
    expect(next?.fg).toBe(THEME.muted);
    expect(next?.bold).toBeUndefined();
  });

  it("never paints a pending step in warning amber", () => {
    const rows = liveRows(plan(), VIEWPORT);
    const colours = rows.flatMap((row) => row.segments.map((segment) => segment.fg));
    expect(colours).not.toContain(THEME.warning);
  });

  it("moves the current step's mark with the frame", () => {
    const glyphs = getGlyphs();
    const markAt = (tick: number): string | undefined => {
      const rows = liveRows(plan(), VIEWPORT, false, glyphs, undefined, tick);
      const row = rows.find((candidate) =>
        candidate.segments.some((segment) => segment.text === "compare the three venues"),
      );
      return row?.segments[1]?.text;
    };
    expect(markAt(0)).not.toBe(markAt(1));
    expect(glyphs.spinnerFrames).toContain(markAt(0) ?? "");
  });
});
