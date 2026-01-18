
import { describe, expect, it } from "bun:test";
import chalk from "chalk";
import { formatLinks, formatMarkdown } from "./markdown-formatter";

describe("markdown-formatter", () => {
  describe("formatLinks", () => {
    it("should format standard links correctly", () => {
      const input = "[Link Text](http://example.com)";
      const expected = chalk.blue.underline("Link Text");
      expect(formatLinks(input)).toBe(expected);
    });

    it("should not consume ANSI escape sequences that look like links", () => {
      // This tests the regression where \x1b[1m (ANSI bold) was matched as a link start
      const input = "\u001b[1mBold Text";
      // The function should leave the ANSI code intact
      expect(formatLinks(input)).toBe(input);
    });

    it("should format links correctly even when preceded by ANSI codes", () => {
      const input = "\u001b[1mPrefix [Link](url)";
      const expected = "\u001b[1mPrefix " + chalk.blue.underline("Link");
      expect(formatLinks(input)).toBe(expected);
    });
  });

  describe("formatMarkdown", () => {
    it("should handle formatting around headers without corruption", () => {
      // Simulate input that might have caused issues before
      const input = "# Release 0.6.1";
      const result = formatMarkdown(input);
      expect(result).toBe(chalk.bold.blue.underline("Release 0.6.1"));
      // Ensure no leaked ANSI codes as text
      expect(result).not.toContain("1mRelease");
    });
  });
});
