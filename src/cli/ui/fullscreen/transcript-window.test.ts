import { describe, expect, it } from "bun:test";
import {
  applyScrollDelta,
  clampScrollFromBottom,
  transcriptVisibleCount,
  wheelScrollDelta,
  windowTranscriptRows,
} from "./transcript-window";
import type { InputModel, LiveModel } from "./types";

const ROWS = Array.from({ length: 40 }, (_, index) => `line-${String(index).padStart(2, "0")}`);

describe("windowTranscriptRows", () => {
  it("pins to the newest rows at the live edge", () => {
    expect(windowTranscriptRows(ROWS, 10, 0)).toEqual(ROWS.slice(30, 40));
    expect(windowTranscriptRows(ROWS, 10, 0)?.[0]).toBe("line-30");
    expect(windowTranscriptRows(ROWS, 10, 0)?.at(-1)).toBe("line-39");
  });

  it("walks toward older rows as scrollFromBottom grows", () => {
    const windowed = windowTranscriptRows(ROWS, 10, 30);
    expect(windowed[0]).toBe("line-00");
    expect(windowed.at(-1)).toBe("line-09");
    expect(windowed).not.toContain("line-39");
  });

  it("returns every row when the conversation is shorter than the viewport", () => {
    expect(windowTranscriptRows(ROWS.slice(0, 3), 10, 0)).toEqual(ROWS.slice(0, 3));
    expect(windowTranscriptRows(ROWS.slice(0, 3), 10, 99)).toEqual(ROWS.slice(0, 3));
  });

  it("paints nothing when the leftover height is zero, so the composer keeps the rows", () => {
    expect(windowTranscriptRows(ROWS, 0, 0)).toEqual([]);
  });
});

describe("applyScrollDelta", () => {
  it("pages toward older rows and back to the live edge", () => {
    const visible = 10;
    const afterUp = applyScrollDelta(0, ROWS.length, visible, -1, "page");
    expect(windowTranscriptRows(ROWS, visible, afterUp)[0]).toBe("line-21");
    expect(windowTranscriptRows(ROWS, visible, afterUp)).not.toContain("line-39");

    const afterDown = applyScrollDelta(afterUp, ROWS.length, visible, 1, "page");
    expect(afterDown).toBe(0);
    expect(windowTranscriptRows(ROWS, visible, afterDown).at(-1)).toBe("line-39");
  });

  it("jumps Home to the oldest rows and End to the live edge", () => {
    expect(applyScrollDelta(0, ROWS.length, 10, -1, "end")).toBe(30);
    expect(applyScrollDelta(12, ROWS.length, 10, 1, "end")).toBe(0);
  });

  it("clamps past either end", () => {
    expect(applyScrollDelta(0, ROWS.length, 10, 5, "line")).toBe(0);
    expect(applyScrollDelta(0, ROWS.length, 10, -100, "line")).toBe(30);
  });
});

describe("clampScrollFromBottom", () => {
  it("keeps the same rows on screen when new rows arrive while scrolled up", () => {
    const visible = 10;
    const offset = 12;
    const before = windowTranscriptRows(ROWS, visible, offset);
    const grown = [...ROWS, "line-40", "line-41"];
    const kept = clampScrollFromBottom(offset + 2, grown.length, visible);
    expect(windowTranscriptRows(grown, visible, kept)).toEqual(before);
  });
});

describe("wheelScrollDelta", () => {
  it("maps trackpad up to older and down to newer", () => {
    expect(wheelScrollDelta("up", 1)).toBe(-1);
    expect(wheelScrollDelta("down", 3)).toBe(3);
    expect(wheelScrollDelta("left", 1)).toBeNull();
  });
});

describe("transcriptVisibleCount", () => {
  it("subtracts chrome, the live band, and the composer", () => {
    const live: LiveModel = { tools: [], hiddenTools: [], tick: 0, reservedRows: 2 };
    const input: InputModel = {
      value: "",
      placeholder: "Ask anything",
      queued: 0,
      disabled: false,
    };
    expect(
      transcriptVisibleCount({
        viewport: { width: 80, height: 24 },
        live,
        input,
        inputFocused: true,
      }),
    ).toBe(17);
  });

  it("yields every leftover row rather than forcing one that would hide the composer", () => {
    const live: LiveModel = { tools: [], hiddenTools: [], tick: 0, reservedRows: 5 };
    const input: InputModel = {
      value: "",
      placeholder: "Ask anything",
      queued: 0,
      disabled: false,
    };
    expect(
      transcriptVisibleCount({
        viewport: { width: 80, height: 8 },
        live,
        input,
        inputFocused: true,
      }),
    ).toBe(0);
  });
});
