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
