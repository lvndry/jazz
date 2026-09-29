import { describe, expect, test } from "bun:test";
import { latexToUnicode } from "./latex-to-unicode";

describe("latexToUnicode", () => {
  test.each([
    ["\\alpha + \\beta", "α + β"],
    ["x^2 + y^{n+1}", "x² + yⁿ⁺¹"],
    ["a_i, a_{ij}", "aᵢ, aᵢⱼ"],
    ["x_{\\theta}", "x_θ"],
    ["x^{a b c}", "xᵃᵇᶜ"],
    ["e^{i\\pi} + 1 = 0", "e^(iπ) + 1 = 0"],
    ["f'(x) = 2x", "f′(x) = 2x"],
    ["30^\\circ", "30°"],
    ["\\frac{1}{2}", "½"],
    ["\\frac{a}{b}", "a/b"],
    ["\\frac{a+b}{c+d}", "(a+b)/(c+d)"],
    ["\\sqrt{x}", "√x"],
    ["\\sqrt{x^2+1}", "√(x²+1)"],
    ["\\sqrt[3]{8}", "∛8"],
    ["\\sqrt{2\\pi}", "√(2π)"],
    ["\\frac{(x-\\mu)^2}{2\\sigma^2}", "(x−μ)²/2σ²"],
    ["\\frac{f(x)}{g(x)+1}", "f(x)/(g(x)+1)"],
    ["\\sum_{i=1}^{n} i", "∑ᵢ₌₁ⁿ i"],
    ["\\int_0^\\infty e^{-x}\\,dx", "∫₀^∞ e⁻ˣ dx"],
    ["\\lim_{x\\to0} \\frac{\\sin x}{x}", "lim_(x→0) (sin x)/x"],
    ["\\sin\\theta", "sin θ"],
    ["\\mathbb{R}^n", "ℝⁿ"],
    ["\\mathcal{L}", "ℒ"],
    ["\\mathbf{v}", "𝐯"],
    ["\\hat{x} + \\vec{v}", "x̂ + v⃗"],
    ["\\overline{AB}", "A̅B̅"],
    ["a \\leq b \\neq c", "a ≤ b ≠ c"],
    ["x \\not\\in S", "x ∉ S"],
    ["\\forall x \\in \\mathbb{N}", "∀ x ∈ ℕ"],
    ["\\left( \\frac{a}{b} \\right)", "( a/b )"],
    ["a - b", "a − b"],
    ["\\text{if } x > 0", "if x > 0"],
    ["\\binom{n}{k}", "C(n, k)"],
    ["\\langle u,v\\rangle", "⟨u,v⟩"],
    ["\\unknowncommand{x}", "\\unknowncommand{x}"],
  ])("%s", (source, expected) => {
    expect(latexToUnicode(source)).toBe(expected);
  });

  test("a matrix becomes aligned rows between bracket glyphs", () => {
    expect(latexToUnicode("\\begin{pmatrix} 1 & 0 \\\\ 0 & 10 \\end{pmatrix}")).toBe(
      ["⎛ 1  0  ⎞", "⎝ 0  10 ⎠"].join("\n"),
    );
  });

  test("a single-row matrix uses plain brackets", () => {
    expect(latexToUnicode("\\begin{bmatrix} a & b \\end{bmatrix}")).toBe("[ a  b ]");
  });

  test("cases open with a brace and sit under the text before them", () => {
    expect(
      latexToUnicode("f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & \\text{otherwise} \\end{cases}"),
    ).toBe(["f(x) = ⎧ 1  x > 0", "       ⎩ 0  otherwise"].join("\n"));
  });

  test("aligned equations right-align the left column", () => {
    expect(latexToUnicode("\\begin{aligned} x &= 1 \\\\ yy &= 2 \\end{aligned}")).toBe(
      [" x = 1", "yy = 2"].join("\n"),
    );
  });

  test("an environment inside a group still closes at its own end", () => {
    expect(
      latexToUnicode(
        "\\left\\{\\begin{aligned} a &= 1 \\\\ b &= 2 \\end{aligned}\\right. + \\begin{matrix} 1 \\end{matrix}",
      ),
    ).toBe(["{a = 1", " b = 2 + 1"].join("\n"));
  });

  test("a command name is never read from the object prototype", () => {
    expect(latexToUnicode("\\constructor \\toString")).toBe("\\constructor \\toString");
  });

  test("unbalanced input never throws", () => {
    expect(() => latexToUnicode("\\frac{a}{ \\begin{matrix} a & \\sqrt[ x^{")).not.toThrow();
  });
});
