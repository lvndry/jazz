import {
  bold,
  code,
  codeBlock,
  line,
  markdown,
  plainLine,
  quote,
  text,
} from "@jazz/bot-shared/surface";
import { describe, expect, test } from "bun:test";
import { escapePrices, escapeRichMarkdown, toRichMarkdown } from "./rich-markdown";

describe("escapePrices", () => {
  test("a dollar before a digit is a price, not the start of a formula", () => {
    expect(escapePrices("It costs $5 or $10.99 a month")).toBe("It costs \\$5 or \\$10.99 a month");
  });

  test("a formula the model meant stays a formula", () => {
    expect(escapePrices("Area is $\\pi r^2$ and $$E = mc^2$$")).toBe(
      "Area is $\\pi r^2$ and $$E = mc^2$$",
    );
  });

  test("code is left exactly as written", () => {
    expect(escapePrices("Run `echo $1` then\n```sh\nexport PRICE=$5\n```\nfor $3")).toBe(
      "Run `echo $1` then\n```sh\nexport PRICE=$5\n```\nfor \\$3",
    );
  });
});

describe("escapeRichMarkdown", () => {
  test("text that looks like Markdown shows as written", () => {
    expect(escapeRichMarkdown("1. *not* a list_item #tag $5 <b>")).toBe(
      "1\\. \\*not\\* a list\\_item \\#tag \\$5 \\<b\\>",
    );
  });
});

describe("toRichMarkdown", () => {
  test("the model's Markdown passes through, and each bridge line is its own paragraph", () => {
    expect(
      toRichMarkdown([
        markdown("| a | b |\n|---|---|\n| 1 | 2 |"),
        plainLine(""),
        line(bold("✅ Done"), text(" · "), code("web_search")),
        plainLine("12 tokens"),
      ]),
    ).toBe("| a | b |\n|---|---|\n| 1 | 2 |\n\n**✅ Done** · `web_search`\n\n12 tokens");
  });

  test("code with backticks in it keeps its fences intact", () => {
    expect(toRichMarkdown([line(code("a`b"))])).toBe("``a`b``");
    expect(toRichMarkdown([codeBlock("x = ```", "py")])).toBe("~~~py\nx = ```\n~~~");
  });

  test("a quote is a block quotation of escaped text", () => {
    expect(toRichMarkdown([quote("**not bold**\nsecond")])).toBe(">\\*\\*not bold\\*\\*\n>second");
  });
});
