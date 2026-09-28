import { describe, expect, it } from "bun:test";
import { THEME } from "../theme";
import {
  continueFenceHighlight,
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
    expect(pathFromFileArgsPreview("src/app.py  def main():")).toBe("src/app.py");
  });

  it("carries a block comment across fence lines", () => {
    const rows = highlightFenceLines("js", [
      "const x = 1; /* start",
      "  still a comment",
      "  end */ const y = 2;",
    ]);
    expect(rows[0]?.find((span) => span.text.includes("start"))?.fg).toBe(THEME.muted);
    expect(rows[1]).toEqual([{ text: "  still a comment", fg: THEME.muted }]);
    const closed = rows[2] ?? [];
    expect(closed.find((span) => span.text.includes("end"))?.fg).toBe(THEME.muted);
    expect(closed.find((span) => span.text === "const")?.fg).toBe(THEME.syntaxStructure);
  });

  it("does not leak a line comment onto the next line", () => {
    const rows = highlightFenceLines("js", ["return 1; // leftover", "const next = 2;"]);
    expect(rows[1]?.find((span) => span.text === "const")?.fg).toBe(THEME.syntaxStructure);
  });

  it("carries an unclosed string across fence lines", () => {
    const rows = highlightFenceLines("js", ['const name = "jazz', 'still"']);
    expect(rows[0]?.find((span) => span.text.includes("jazz"))?.fg).toBe(THEME.syntaxValue);
    expect(rows[1]?.map((span) => span.text).join("")).toBe('still"');
    expect(rows[1]?.every((span) => span.fg === THEME.syntaxValue)).toBe(true);
  });

  it("does not treat quotes inside a block comment as a string", () => {
    const rows = highlightFenceLines("js", ['/* "not a string', "still comment */ let x"]);
    expect(rows[1]?.find((span) => span.text.includes("still comment"))?.fg).toBe(THEME.muted);
    expect(rows[1]?.find((span) => span.text === "let")?.fg).toBe(THEME.syntaxStructure);
  });

  it("does not start a comment inside a string", () => {
    const spans = highlightCodeLine('"/* not a comment" const x');
    expect(spans.find((span) => span.text.includes("/*"))?.fg).toBe(THEME.syntaxValue);
    expect(spans.find((span) => span.text === "const")?.fg).toBe(THEME.syntaxStructure);
  });

  it("does not carry comment state across diff lines", () => {
    const rows = highlightFenceLines("diff", [
      "--- a/file",
      "+++ b/file",
      "+const x = 1; /* start",
      "+const y = 2;",
    ]);
    expect(rows[3]?.find((span) => span.text === "const")?.fg).toBe(THEME.syntaxStructure);
  });
});

describe("comment syntax follows the fence's language", () => {
  const painted = (language: string, line: string, fg: string): string =>
    (highlightFenceLines(language, [line])[0] ?? [])
      .filter((span) => span.fg === fg)
      .map((span) => span.text)
      .join("");

  it("never reads a URL's `//` as a shell comment", () => {
    const line = "curl -fsSL https://example.com/install.sh | bash";
    for (const language of ["bash", "sh", "shell", "zsh", "console", ""]) {
      expect(painted(language, line, THEME.muted)).toBe("");
    }
  });

  it("treats `#` as a comment only where a token starts", () => {
    expect(painted("bash", "echo hi # say hi", THEME.muted)).toBe("# say hi");
    expect(painted("bash", 'echo "${#items[@]}"', THEME.muted)).toBe("");
    expect(painted("bash", "echo $#", THEME.muted)).toBe("");
    expect(painted("python", "x = 1  # note", THEME.muted)).toBe("# note");
  });

  it("keeps `#` as code in languages where it is not a comment", () => {
    expect(painted("css", ".brand { color: #00d7ff; }", THEME.muted)).toBe("");
    expect(painted("ts", "class A { #secret = 1; }", THEME.muted)).toBe("");
    expect(painted("rust", "#[derive(Debug)]", THEME.muted)).toBe("");
    expect(painted("json", '{ "url": "https://x.dev" }', THEME.muted)).toBe("");
  });

  it("paints `--` comments in SQL and Lua only", () => {
    expect(painted("sql", "select 1 -- one", THEME.muted)).toBe("-- one");
    expect(painted("lua", "local x = 1 -- one", THEME.muted)).toBe("-- one");
    expect(painted("bash", "ls --all", THEME.muted)).toBe("");
  });

  it("does not open a string at a Rust lifetime", () => {
    const spans = highlightFenceLines("rust", ["fn get<'a>(value: &'a str) -> &'a str {"])[0] ?? [];
    expect(spans.filter((span) => span.fg === THEME.syntaxValue)).toHaveLength(0);
    expect(painted("rust", "let letter = 'x';", THEME.syntaxValue)).toBe("'x'");
  });

  it("leaves prose fences uncoloured so apostrophes stay text", () => {
    const rows = highlightFenceLines("text", ["don't // stop # here"]);
    expect(rows[0]).toEqual([{ text: "don't // stop # here", fg: THEME.selected }]);
  });

  describe("a fence highlighted as it streams", () => {
    const streamLines = (language: string, lines: readonly string[]): void => {
      let highlight = continueFenceHighlight(undefined, language, []);
      for (let count = 1; count <= lines.length; count += 1) {
        const prefix = lines.slice(0, count);
        const last = prefix[count - 1] ?? "";
        // The last line grows a character at a time, as a reveal delivers it.
        for (let length = 0; length <= last.length; length += 1) {
          const partial = [...prefix.slice(0, -1), last.slice(0, length)];
          highlight = continueFenceHighlight(highlight, language, partial);
          expect(highlight.spans).toEqual(highlightFenceLines(language, partial));
        }
      }
    };

    it("matches a whole-fence highlight, including a comment carried across lines", () => {
      streamLines("ts", ["/* opens", "   closes */", 'const text = "a string";', "call(text);"]);
    });

    it("repaints every line when the fence turns out to be a diff", () => {
      streamLines("", ["notes about the change", "--- a/file.ts", "+++ b/file.ts", "-old", "+new"]);
    });

    it("starts over when the language changes", () => {
      const first = continueFenceHighlight(undefined, "ts", ["const a = 1;", "const b"]);
      const second = continueFenceHighlight(first, "python", ["const a = 1;", "const b"]);
      expect(second.spans).toEqual(highlightFenceLines("python", ["const a = 1;", "const b"]));
    });
  });
});
