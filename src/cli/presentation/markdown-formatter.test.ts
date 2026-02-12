import { describe, expect, it } from "bun:test";
import { formatLinks, formatMarkdown } from "./markdown-formatter";
import { CHALK_THEME } from "../ui/theme";

describe("markdown-formatter", () => {
  describe("formatLinks", () => {
    it("should format standard links correctly", () => {
      const input = "[Link Text](http://example.com)";
      const result = formatLinks(input);
      // Should contain the styled link text
      expect(result).toContain(CHALK_THEME.link("Link Text"));
      // Should contain OSC 8 hyperlink sequences wrapping the URL
      expect(result).toContain("\x1b]8;;http://example.com\x07");
      expect(result).toContain("\x1b]8;;\x07");
    });

    it("should not consume ANSI escape sequences that look like links", () => {
      // This tests the regression where \x1b[1m (ANSI bold) was matched as a link start
      const input = "\u001b[1mBold Text";
      // The function should leave the ANSI code intact
      expect(formatLinks(input)).toBe(input);
    });

    it("should format links correctly even when preceded by ANSI codes", () => {
      const input = "\u001b[1mPrefix [Link](url)";
      const result = formatLinks(input);
      // Should preserve the ANSI prefix and contain styled link text
      expect(result).toContain("\u001b[1mPrefix ");
      expect(result).toContain(CHALK_THEME.link("Link"));
      // Should contain OSC 8 hyperlink wrapping the URL
      expect(result).toContain("\x1b]8;;url\x07");
    });
  });

  describe("formatMarkdown", () => {
    it("should handle formatting around headers without corruption", () => {
      // Simulate input that might have caused issues before
      const input = "# Release 0.6.1";
      const result = formatMarkdown(input);
      expect(result).toBe(CHALK_THEME.headingUnderline("Release 0.6.1"));
      // Ensure no leaked ANSI codes as text
      expect(result).not.toContain("1mRelease");
    });
  });
});
