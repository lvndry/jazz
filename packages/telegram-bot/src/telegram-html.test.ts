import { describe, expect, it } from "bun:test";
import { expandableBlockquote, markdownToTelegramHtml } from "./telegram-html";

describe("expandableBlockquote", () => {
  it("wraps text in a collapsed, tap-to-expand quote", () => {
    expect(expandableBlockquote("thinking out loud")).toBe(
      "<blockquote expandable>thinking out loud</blockquote>",
    );
  });

  it("escapes markup so reasoning about HTML can't break the message", () => {
    const wrapped = expandableBlockquote("use <b> & </blockquote>");
    expect(wrapped).toBe(
      "<blockquote expandable>use &lt;b&gt; &amp; &lt;/blockquote&gt;</blockquote>",
    );
  });
});

describe("markdownToTelegramHtml math", () => {
  it("rewrites inline math as escaped Unicode that no mark restyles", () => {
    expect(markdownToTelegramHtml("Let $a_{\\theta} < b_{\\theta}$ hold, *really*.")).toBe(
      "Let a_θ &lt; b_θ hold, <i>really</i>.",
    );
  });

  it("puts a multi-line block in <pre> so its columns line up", () => {
    const markdown = "$$\n\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}\n$$";
    expect(markdownToTelegramHtml(markdown)).toBe("<pre>⎛ 1  0 ⎞\n⎝ 0  1 ⎠</pre>");
  });

  it("leaves currency alone", () => {
    expect(markdownToTelegramHtml("It costs $5 and $10.")).toBe("It costs $5 and $10.");
  });
});
