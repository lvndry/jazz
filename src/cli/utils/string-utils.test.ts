import { describe, expect, it } from "bun:test";
import chalk from "chalk";
import {
  getVisualWidth,
  padRight,
  stripAnsiCodes,
  truncateMiddle,
  wrapCommaList,
} from "./string-utils";

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
});
