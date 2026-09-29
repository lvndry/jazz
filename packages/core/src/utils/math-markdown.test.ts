import { describe, expect, test } from "bun:test";
import { convertMathInMarkdown, matchDisplayMath, matchInlineMath } from "./math-markdown";

describe("matchInlineMath", () => {
  test("reads a dollar-delimited formula", () => {
    expect(matchInlineMath("so $x^2$ holds", 3)).toMatchObject({ source: "x^2", end: 8 });
  });

  test("reads the parenthesis and double-dollar forms", () => {
    expect(matchInlineMath("\\(a+b\\)", 0)).toMatchObject({ source: "a+b", open: "\\(" });
    expect(matchInlineMath("$$a+b$$", 0)).toMatchObject({ source: "a+b", open: "$$" });
  });

  test.each([
    "costs $5 and $10 today",
    "$5, or $10.",
    "US$5, EU$6",
    "$HOME/$USER",
    "a lone $ sign",
    "$ spaced $",
    "$unclosed",
  ])("leaves prose alone: %s", (text) => {
    for (let index = 0; index < text.length; index += 1) {
      expect(matchInlineMath(text, index)).toBeUndefined();
    }
  });

  test("finds a formula after a price", () => {
    const text = "It costs $5 but $x$ is free";
    expect(matchInlineMath(text, text.indexOf("$x"))).toMatchObject({ source: "x" });
  });
});

describe("matchDisplayMath", () => {
  test("reads a one-line block", () => {
    expect(matchDisplayMath(["$$ E = mc^2 $$"], 0)).toMatchObject({
      source: "E = mc^2",
      nextLine: 1,
    });
    expect(matchDisplayMath(["\\[ a \\]"], 0)).toMatchObject({ source: "a", open: "\\[" });
  });

  test("reads a block spread over lines", () => {
    const lines = ["$$", "a = b", "c = d", "$$", "after"];
    expect(matchDisplayMath(lines, 0)).toMatchObject({ source: "a = b\nc = d", nextLine: 4 });
  });

  test("an unclosed block is not math yet", () => {
    expect(matchDisplayMath(["$$", "a = b"], 0)).toBeUndefined();
  });

  test("reads a bare display environment", () => {
    const lines = ["\\begin{align}", "x &= 1", "\\end{align}"];
    expect(matchDisplayMath(lines, 0)).toMatchObject({ nextLine: 3 });
    expect(matchDisplayMath(["\\begin{itemize}", "\\end{itemize}"], 0)).toBeUndefined();
  });
});

describe("convertMathInMarkdown", () => {
  const wrap = (unicode: string, display: boolean): string =>
    display ? `[[${unicode}]]` : `<${unicode}>`;

  test("replaces inline and display formulas and leaves the rest", () => {
    const markdown = [
      "Let $x_1$ be \\(\\alpha\\).",
      "$$",
      "\\sum_i i",
      "$$",
      "Costs $5 and $10.",
    ].join("\n");
    expect(convertMathInMarkdown(markdown, wrap)).toBe(
      ["Let <x₁> be <α>.", "[[∑ᵢ i]]", "Costs $5 and $10."].join("\n"),
    );
  });

  test("an escaped dollar is not a delimiter", () => {
    expect(convertMathInMarkdown("\\$a\\$ and $b$", wrap)).toBe("\\$a\\$ and <b>");
  });
});
