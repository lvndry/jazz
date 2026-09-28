/// <reference types="bun-types/test" />

import { describe, expect, it } from "bun:test";
import {
  clipTerminalCells,
  clipTerminalCellsFromStart,
  fitTerminalSegments,
  sliceTerminalCells,
  sliceTerminalCellsFromEnd,
  terminalCellWidth,
  wrapTerminalCells,
} from "./terminal-cells";

describe("terminal cell measurement", () => {
  it("measures wide and composed graphemes by terminal cells", () => {
    expect(terminalCellWidth("漢")).toBe(2);
    expect(terminalCellWidth("👨‍👩‍👧‍👦")).toBe(2);
    expect(terminalCellWidth("e\u0301")).toBe(1);
  });

  it("slices without splitting graphemes or exceeding the cell budget", () => {
    expect(sliceTerminalCells("A漢👨‍👩‍👧‍👦e\u0301Z", 5)).toBe("A漢👨‍👩‍👧‍👦");
    expect(sliceTerminalCells("漢A", 1)).toBe("");
    expect(sliceTerminalCellsFromEnd("A漢👨‍👩‍👧‍👦e\u0301Z", 5)).toBe("👨‍👩‍👧‍👦e\u0301Z");
  });

  it("clips with an ellipsis while preserving whole graphemes", () => {
    expect(clipTerminalCells("A漢字👨‍👩‍👧‍👦Z", 4)).toBe("A漢…");
    expect(clipTerminalCellsFromStart("A漢字👨‍👩‍👧‍👦Z", 4)).toBe("…👨‍👩‍👧‍👦Z");
    expect(clipTerminalCells("e\u0301e\u0301e\u0301", 2)).toBe("e\u0301…");
    expect(terminalCellWidth(clipTerminalCells("A漢字👨‍👩‍👧‍👦Z", 4))).toBe(4);
    expect(terminalCellWidth(clipTerminalCellsFromStart("A漢字👨‍👩‍👧‍👦Z", 4))).toBe(4);
  });

  it("wraps at exact cell boundaries without splitting graphemes", () => {
    expect(wrapTerminalCells("A漢👨‍👩‍👧‍👦e\u0301Z", 3)).toEqual(["A漢", "👨‍👩‍👧‍👦e\u0301", "Z"]);
  });

  it("carries a whole word onto the next line instead of splitting it", () => {
    expect(wrapTerminalCells("abc helloworld", 10)).toEqual(["abc ", "helloworld"]);
    expect(wrapTerminalCells("hello world", 8)).toEqual(["hello ", "world"]);
  });

  it("still breaks mid-word when a single word cannot fit any line", () => {
    expect(wrapTerminalCells("supercalifragilistic", 8)).toEqual(["supercal", "ifragili", "stic"]);
  });

  it("keeps every character across wrapped lines, including the space", () => {
    const text = "abc helloworld and more words";
    for (let width = 1; width <= text.length; width += 1) {
      expect(wrapTerminalCells(text, width).join("")).toBe(text);
    }
  });

  it("fits styled segments across segment boundaries", () => {
    const fitted = fitTerminalSegments(
      [
        { text: "A漢", tone: "one" },
        { text: "👨‍👩‍👧‍👦e\u0301Z", tone: "two" },
      ],
      5,
    );
    expect(fitted).toEqual([
      { text: "A漢", tone: "one" },
      { text: "👨‍👩‍👧‍👦", tone: "two" },
    ]);
    expect(terminalCellWidth(fitted.map((segment) => segment.text).join(""))).toBe(5);
  });
});
