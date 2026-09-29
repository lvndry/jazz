/** Regression coverage for shared styled wrapping: oversized tokens and Unicode boundaries. */
import { describe, expect, it } from "bun:test";
import { terminalCellWidth } from "./terminal-cells";
import { wrapStyledSpans } from "./wrap";

describe("wrapStyledSpans", () => {
  it("preserves a long Unicode token and its style even at a one-cell measure", () => {
    const text = "e\u0301👩‍💻界".repeat(100);
    const rows = wrapStyledSpans([{ text, color: "blue" }], 1, (a, b) => a.color === b.color);
    expect(
      rows
        .flat()
        .map((span) => span.text)
        .join(""),
    ).toBe(text);
    expect(rows.every((row) => row.length === 1 && row[0]?.color === "blue")).toBe(true);
    expect(rows.length).toBe(300);
  });

  it("wraps a 50k token without losing content or overflowing cells", () => {
    const text = "a".repeat(50_000);
    const rows = wrapStyledSpans([{ text }], 80, () => true);
    expect(
      rows
        .flat()
        .map((span) => span.text)
        .join(""),
    ).toBe(text);
    expect(rows.length).toBe(625);
    expect(
      rows.every((row) => terminalCellWidth(row.map((span) => span.text).join("")) <= 80),
    ).toBe(true);
  });
});
