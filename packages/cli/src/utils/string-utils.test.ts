import { describe, expect, it } from "bun:test";
import chalk from "chalk";
import {
  getVisualWidth,
  padRight,
  stripAnsiCodes,
  terminalHyperlinksToMarkdown,
  truncateMiddle,
  truncateTailAnsiSafe,
  wrapCommaList,
} from "./string-utils";

// Force chalk to enable colors in test environment
// Chalk v4 disables colors when stdout is not a TTY, so we need to force it
if (chalk.level === 0) {
  chalk.level = 1; // Enable basic colors
}

describe("string-utils", () => {
  describe("stripAnsiCodes", () => {
    it("should strip colors", () => {
      const text = chalk.red("hello");
      expect(text).not.toBe("hello");
      expect(stripAnsiCodes(text)).toBe("hello");
    });

    it("should strip background colors", () => {
      const text = chalk.bgBlue("hello");
      expect(stripAnsiCodes(text)).toBe("hello");
    });
  });

  describe("getVisualWidth", () => {
    it("should return length ignoring ansi codes", () => {
      const text = chalk.bold(chalk.blue("hello"));
      expect(text.length).toBeGreaterThan(5);
      expect(getVisualWidth(text)).toBe(5);
    });
  });

  describe("padRight", () => {
    it("should pad plain text", () => {
      expect(padRight("hello", 10)).toBe("hello     ");
    });

    it("should pad ansi text correctly", () => {
      const text = chalk.blue("hello");
      const padded = padRight(text, 10);
      expect(getVisualWidth(padded)).toBe(10);
      expect(padded.endsWith("     ")).toBe(true);
    });
  });

  describe("truncateMiddle", () => {
    it("should truncate long text", () => {
      // For small max, it truncates at end
      expect(truncateMiddle("1234567890", 5)).toBe("1234…");
      // For larger max, it truncates in middle
      expect(truncateMiddle("123456789012345", 12)).toBe("1234567…2345"); // 7 + 1 + 4 chars = 12
    });
  });

  describe("wrapCommaList", () => {
    it("should wrap items", () => {
      const items = ["one", "two", "three", "four"];
      // "one, two" = 8 chars. "three, four" = 11 chars. width 10.
      // So "three, four" doesn't fit. "three" fits. "four" fits.
      const wrapped = wrapCommaList(items, 10);
      expect(wrapped).toEqual(["one, two", "three", "four"]);
    });

    it("should handle single item exceeding width", () => {
      const items = ["superlongitemname"];
      const wrapped = wrapCommaList(items, 5);
      expect(wrapped).toEqual(["superlongitemname"]);
    });
  });

  describe("truncateTailAnsiSafe", () => {
    it("should return full text when within limit", () => {
      const text = "hello world";
      expect(truncateTailAnsiSafe(text, 20)).toBe("hello world");
    });

    it("should truncate plain text from the start", () => {
      const text = "hello world";
      const result = truncateTailAnsiSafe(text, 5);
      expect(result).toBe("world");
    });

    it("should not split ANSI sequences when truncating", () => {
      const text = chalk.red("hello") + " " + chalk.blue("world");
      const result = truncateTailAnsiSafe(text, 5);
      expect(stripAnsiCodes(result)).toBe("world");
      // Should not have partial/broken ANSI escape (e.g., \x1b[ without the terminating char)
      // eslint-disable-next-line no-control-regex
      expect(result).not.toMatch(/\u001b\[(?![0-9;]*[A-Za-z])/);
      // eslint-disable-next-line no-control-regex
      expect(result).not.toMatch(/\u001b$/);
    });

    it("should preserve ANSI codes in the kept portion", () => {
      const text = "prefix " + chalk.green("hello") + " " + chalk.yellow("world");
      const result = truncateTailAnsiSafe(text, 11);
      expect(stripAnsiCodes(result)).toBe("hello world");
    });

    it("should handle text that is all ANSI codes", () => {
      const text = chalk.red("hi");
      const result = truncateTailAnsiSafe(text, 2);
      expect(stripAnsiCodes(result)).toBe("hi");
    });

    it("should return empty string for maxVisibleChars <= 0", () => {
      expect(truncateTailAnsiSafe("hello", 0)).toBe("");
      expect(truncateTailAnsiSafe("hello", -1)).toBe("");
    });

    it("should handle nested ANSI styling", () => {
      const text = chalk.bold(chalk.red("hello")) + " plain " + chalk.blue("world");
      const result = truncateTailAnsiSafe(text, 5);
      expect(stripAnsiCodes(result)).toBe("world");
    });

    it("should correctly count visible chars with multiple ANSI sequences", () => {
      const text =
        chalk.red("a") + chalk.green("b") + chalk.blue("c") + chalk.yellow("d") + chalk.cyan("e");
      const result = truncateTailAnsiSafe(text, 3);
      expect(stripAnsiCodes(result)).toBe("cde");
    });
  });
});

describe("terminalHyperlinksToMarkdown", () => {
  const ESC = "\x1b";
  const BEL = "\x07";
  const hyperlink = (url: string, label: string, terminator = BEL): string =>
    `${ESC}]8;;${url}${terminator}${label}${ESC}]8;;${terminator}`;

  it("rewrites a hyperlink as a markdown link that keeps its target", () => {
    const text = `see ${hyperlink("https://example.com/guide", "the guide")} now`;
    expect(terminalHyperlinksToMarkdown(text)).toBe(
      "see [the guide](https://example.com/guide) now",
    );
  });

  it("accepts the ST terminator as well as BEL", () => {
    const text = hyperlink("https://example.com", "site", `${ESC}\\`);
    expect(terminalHyperlinksToMarkdown(text)).toBe("[site](https://example.com)");
  });

  it("keeps colour inside the label for the later strip to remove", () => {
    const text = hyperlink("https://example.com", `${ESC}[34mblue${ESC}[39m`);
    expect(stripAnsiCodes(terminalHyperlinksToMarkdown(text))).toBe("[blue](https://example.com)");
  });

  it("percent-encodes parentheses so the URL is not cut short", () => {
    const text = hyperlink("https://en.wikipedia.org/wiki/Jazz_(word)", "Jazz");
    expect(terminalHyperlinksToMarkdown(text)).toBe(
      "[Jazz](https://en.wikipedia.org/wiki/Jazz_%28word%29)",
    );
  });

  it("falls back to the bare label when brackets would break the markdown", () => {
    expect(terminalHyperlinksToMarkdown(hyperlink("https://example.com", "[1]"))).toBe("[1]");
  });

  it("converts every link in a line independently", () => {
    const text = `${hyperlink("https://a.dev", "a")} and ${hyperlink("https://b.dev", "b")}`;
    expect(terminalHyperlinksToMarkdown(text)).toBe("[a](https://a.dev) and [b](https://b.dev)");
  });
});
