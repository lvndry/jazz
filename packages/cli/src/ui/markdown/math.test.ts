import { describe, expect, it } from "bun:test";
import { stripAnsiCodes } from "../../utils/string-utils";
import { GLYPHS } from "../glyphs";
import { markdownToAnsi } from "./ansi";
import { parseMarkdown } from "./parse";

const glyphs = GLYPHS.unicode;

function plain(markdown: string, syntax: "rendered" | "hybrid" = "rendered"): string {
  return stripAnsiCodes(markdownToAnsi(markdown, { width: 88, glyphs, syntax }));
}

describe("inline math", () => {
  it("renders $…$ and \\(…\\) as Unicode inside prose", () => {
    expect(plain("Then $x^2 + \\alpha_1$ and \\(\\sqrt{y}\\) hold.")).toBe(
      "Then x² + α₁ and √y hold.",
    );
  });

  it("is not read as emphasis or an escape", () => {
    expect(plain("Set $a_i * b_j$ and *stress*")).toBe("Set aᵢ * bⱼ and stress");
  });

  it("leaves currency alone", () => {
    expect(plain("It costs $5 and then $10.")).toBe("It costs $5 and then $10.");
  });

  it("keeps the surrounding style", () => {
    const [block] = parseMarkdown("**bold $x^2$ text**", { glyphs });
    expect(block).toMatchObject({ kind: "text" });
    const spans = block?.kind === "text" ? block.spans : [];
    expect(spans.every((span) => span.bold === true)).toBe(true);
    expect(spans.map((span) => span.text).join("")).toBe("bold x² text");
  });

  it("keeps the delimiters but still renders in hybrid syntax", () => {
    expect(plain("Then $x^2$ and \\(y_1\\).", "hybrid")).toBe("Then $x²$ and \\(y₁\\).");
  });

  it("does not touch code spans", () => {
    expect(plain("Run `echo $a_1 $b_2` now")).toBe("Run echo $a_1 $b_2 now");
  });

  it("works inside headings, lists and tables", () => {
    expect(plain("# The $\\pi$ day")).toBe("The π day");
    expect(plain("- area $\\pi r^2$")).toBe(`  ${glyphs.bullet} area π r²`);
    expect(plain("| f | v |\n| - | - |\n| $x_1$ | $\\infty$ |")).toContain("x₁");
  });
});

describe("display math", () => {
  it("sets a $$ block off from the prose and indents it", () => {
    expect(plain("Euler:\n$$\ne^{i\\theta} = \\cos\\theta + i\\sin\\theta\n$$\nDone.")).toBe(
      ["Euler:", "", "    eⁱᶿ = cos θ + i sin θ", "", "Done."].join("\n"),
    );
  });

  it("reads one-line $$…$$ and \\[…\\] blocks", () => {
    expect(plain("$$ a \\leq b $$")).toBe("    a ≤ b");
    expect(plain("\\[ \\frac{1}{2} \\]")).toBe("    ½");
  });

  it("keeps a matrix aligned", () => {
    expect(plain("$$\\begin{pmatrix} 1 & 0 \\\\ 0 & 10 \\end{pmatrix}$$")).toBe(
      ["    ⎛ 1  0  ⎞", "    ⎝ 0  10 ⎠"].join("\n"),
    );
  });

  it("keeps aligned equations lined up through the indentation", () => {
    expect(plain("$$\\begin{aligned} x &= 1 \\\\ yy &= 2 \\end{aligned}$$")).toBe(
      ["     x = 1", "    yy = 2"].join("\n"),
    );
  });

  it("reads a bare align environment and a math fence", () => {
    expect(plain("\\begin{align}\na &= 1\n\\end{align}")).toBe("    a = 1");
    expect(plain("```math\n\\alpha + \\beta\n```")).toBe("    α + β");
  });

  it("leaves a still-streaming block as the text it is", () => {
    expect(plain("Before\n$$\n\\alpha")).toContain("$$");
  });

  it("keeps the delimiters on their own lines in hybrid syntax", () => {
    expect(plain("$$\n\\alpha + \\beta\n$$", "hybrid")).toBe("$$\n    α + β\n$$");
    expect(plain("```math\n\\alpha\n```", "hybrid")).toBe("```math\n    α\n```");
  });

  it("breaks a paragraph that runs straight into a display block", () => {
    const blocks = parseMarkdown("Intro line\n$$\nx\n$$", { glyphs });
    expect(blocks.map((block) => block.kind)).toEqual(["text", "blank", "text", "blank"]);
  });
});
