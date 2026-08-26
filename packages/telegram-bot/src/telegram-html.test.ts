import { describe, expect, it } from "bun:test";
import { expandableBlockquote } from "./telegram-html";

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
