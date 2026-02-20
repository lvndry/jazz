import { describe, expect, it } from "bun:test";
import chalk from "chalk";
import {
  getVisualWidth,
  padRight,
  stripAnsiCodes,
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
