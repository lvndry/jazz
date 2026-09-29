import { describe, expect, test } from "bun:test";
import { markdownToPlainText, markdownToWhatsApp } from "./markdown-dialects";

const answer = [
  "## Plan",
  "**Buy** milk and *eggs*, not ~~bread~~.",
  "- one",
  "- two",
  "See [the list](https://example.com/list).",
  "```js",
  "const total = a * b ** 2;",
  "```",
  "Run `a*b` first.",
].join("\n");

describe("markdownToWhatsApp", () => {
  test("uses WhatsApp's own marks and leaves code alone", () => {
    expect(markdownToWhatsApp(answer)).toBe(
      [
        "*Plan*",
        "*Buy* milk and _eggs_, not ~bread~.",
        "• one",
        "• two",
        "See the list (https://example.com/list).",
        "```",
        "const total = a * b ** 2;",
        "```",
        "Run `a*b` first.",
      ].join("\n"),
    );
  });
});

describe("markdownToPlainText", () => {
  test("drops the marks and keeps the words, links and code", () => {
    expect(markdownToPlainText(answer)).toBe(
      [
        "Plan",
        "Buy milk and eggs, not bread.",
        "• one",
        "• two",
        "See the list (https://example.com/list).",
        "const total = a * b ** 2;",
        "Run a*b first.",
      ].join("\n"),
    );
  });

  test("leaves snake_case and arithmetic as written", () => {
    expect(markdownToPlainText("set max_retries to 2 * 3")).toBe("set max_retries to 2 * 3");
  });
});

describe("math", () => {
  const formula = [
    "Let $x_i^2 + \\alpha$ be *small*.",
    "$$",
    "\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}",
    "$$",
    "It costs $5 and $10.",
  ].join("\n");

  test("WhatsApp gets Unicode, with a matrix kept in a monospace block", () => {
    expect(markdownToWhatsApp(formula)).toBe(
      [
        "Let xᵢ² + α be _small_.",
        "```",
        "⎛ 1  0 ⎞",
        "⎝ 0  1 ⎠",
        "```",
        "It costs $5 and $10.",
      ].join("\n"),
    );
  });

  test("Messages gets plain Unicode", () => {
    expect(markdownToPlainText(formula)).toBe(
      ["Let xᵢ² + α be small.", "⎛ 1  0 ⎞", "⎝ 0  1 ⎠", "It costs $5 and $10."].join("\n"),
    );
  });

  test("a subscript is not read as emphasis", () => {
    expect(markdownToWhatsApp("$a_{\\theta} b_{\\theta}$")).toBe("a_θ b_θ");
  });

  test("math inside code stays code", () => {
    expect(markdownToWhatsApp("Run `echo $a_1 $b_2`")).toBe("Run `echo $a_1 $b_2`");
  });
});
