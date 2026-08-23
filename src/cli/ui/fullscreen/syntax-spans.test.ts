import { describe, expect, it } from "bun:test";
import { THEME } from "../theme";
import {
  highlightCodeLine,
  highlightDiffLine,
  highlightFenceLines,
  looksLikeUnifiedDiff,
  pathFromFileArgsPreview,
  sourceLanguageFromPath,
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
    expect(highlightDiffLine("+added")).toEqual([
      { text: "+", fg: THEME.success },
      { text: "added", fg: THEME.selected },
    ]);
    expect(highlightDiffLine("-gone")).toEqual([
      { text: "-", fg: THEME.error },
      { text: "gone", fg: THEME.selected },
    ]);
    expect(highlightDiffLine("@@ -1,2 +1,2 @@")).toEqual([
      { text: "@@ -1,2 +1,2 @@", fg: THEME.muted },
    ]);
  });

  it("routes a patch fence through the diff painter", () => {
    const rows = highlightFenceLines("patch", ["--- a/file", "+++ b/file", "-a", "+b"]);
    expect(rows[2]).toEqual([
      { text: "-", fg: THEME.error },
      { text: "a", fg: THEME.selected },
    ]);
    expect(rows[3]).toEqual([
      { text: "+", fg: THEME.success },
      { text: "b", fg: THEME.selected },
    ]);
  });

  it("colours Python, bash and JS inside added diff lines", () => {
    const python = highlightDiffLine("+def main():");
    expect(python[0]).toEqual({ text: "+", fg: THEME.success });
    expect(python.find((span) => span.text === "def")?.fg).toBe(THEME.syntaxStructure);
    const js = highlightDiffLine('+const name = "jazz";');
    expect(js.find((span) => span.text === "const")?.fg).toBe(THEME.syntaxStructure);
    expect(js.find((span) => span.text.includes("jazz"))?.fg).toBe(THEME.syntaxValue);
    const bash = highlightDiffLine("+if true; then echo hi; fi");
    expect(bash.find((span) => span.text === "then")?.fg).toBe(THEME.syntaxStructure);
    expect(bash.find((span) => span.text === "fi")?.fg).toBe(THEME.syntaxStructure);
  });

  it("colours Python and bash keywords with the structure role", () => {
    const python = highlightCodeLine("def main():");
    expect(python.find((span) => span.text === "def")?.fg).toBe(THEME.syntaxStructure);
    const bash = highlightCodeLine("if true; then echo hi; fi");
    expect(bash.find((span) => span.text === "then")?.fg).toBe(THEME.syntaxStructure);
    expect(bash.find((span) => span.text === "fi")?.fg).toBe(THEME.syntaxStructure);
  });

  it("only tags real source paths as highlightable", () => {
    expect(sourceLanguageFromPath("src/app.py")).toBe("py");
    expect(sourceLanguageFromPath("bin/run.sh")).toBe("sh");
    expect(sourceLanguageFromPath("index.js")).toBe("js");
    expect(sourceLanguageFromPath("notes.md")).toBeUndefined();
    expect(pathFromFileArgsPreview("file: src/app.py  def main():")).toBe("src/app.py");
  });
});
