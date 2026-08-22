import { describe, expect, it } from "bun:test";
import { THEME } from "../theme";
import {
  highlightCodeLine,
  highlightDiffLine,
  highlightFenceLines,
  looksLikeUnifiedDiff,
} from "./syntax-spans";

describe("syntax-spans", () => {
  it("gives keywords, strings, numbers and types distinct roles", () => {
    const spans = highlightCodeLine('const count = 42; const name = "jazz"; function Agent() {}');
    const byRole = (fg: string): string =>
      spans
        .filter((span) => span.fg === fg)
        .map((span) => span.text)
        .join("");

    expect(byRole(THEME.syntaxStructure)).toContain("const");
    expect(byRole(THEME.syntaxStructure)).toContain("function");
    expect(byRole(THEME.syntaxValue)).toContain("42");
    expect(byRole(THEME.syntaxValue)).toContain('"jazz"');
    expect(byRole(THEME.syntaxType)).toContain("Agent");
    expect(byRole(THEME.success)).toBe("");
  });

  it("keeps comments on the neutral ramp", () => {
    expect(highlightCodeLine("return 1; // leftover")).toEqual([
      { text: "return", fg: THEME.syntaxStructure },
      { text: " ", fg: THEME.secondary },
      { text: "1", fg: THEME.syntaxValue },
      { text: "; ", fg: THEME.secondary },
      { text: "// leftover", fg: THEME.muted },
    ]);
  });

  it("colours a unified diff as added, removed, and chrome", () => {
    expect(looksLikeUnifiedDiff("diff", ["--- a", "+++ b", "-old", "+new"])).toBe(true);
    expect(looksLikeUnifiedDiff("", ["just a list", "- item"])).toBe(false);
    expect(highlightDiffLine("+added")).toEqual([{ text: "+added", fg: THEME.success }]);
    expect(highlightDiffLine("-gone")).toEqual([{ text: "-gone", fg: THEME.error }]);
    expect(highlightDiffLine("@@ -1,2 +1,2 @@")).toEqual([
      { text: "@@ -1,2 +1,2 @@", fg: THEME.muted },
    ]);
  });

  it("routes a patch fence through the diff painter", () => {
    const rows = highlightFenceLines("patch", ["--- a/file", "+++ b/file", "-a", "+b"]);
    expect(rows[2]).toEqual([{ text: "-a", fg: THEME.error }]);
    expect(rows[3]).toEqual([{ text: "+b", fg: THEME.success }]);
  });
});
