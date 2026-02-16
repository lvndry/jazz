import { describe, expect, it } from "bun:test";
import {
  formatEmojiShortcodes,
  formatInlineCode,
  formatLinks,
  formatMarkdown,
  formatMarkdownHybrid,
  getTerminalWidth,
  wrapToWidth,
} from "./markdown-formatter";
import { CHALK_THEME, codeColor } from "../ui/theme";

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

  describe("formatEmojiShortcodes", () => {
    it("should convert known emoji shortcodes to unicode", () => {
      expect(formatEmojiShortcodes(":wave:")).toBe("👋");
      expect(formatEmojiShortcodes(":+1:")).toBe("👍");
      expect(formatEmojiShortcodes(":rocket:")).toBe("🚀");
      expect(formatEmojiShortcodes(":heart:")).toBe("❤️");
      expect(formatEmojiShortcodes(":smile:")).toBe("😄");
    });

    it("should leave unknown shortcodes as-is", () => {
      expect(formatEmojiShortcodes(":not_a_real_emoji_xyz:")).toBe(":not_a_real_emoji_xyz:");
      // :thumbsup: is not a valid node-emoji shortcode (use :+1: instead)
      expect(formatEmojiShortcodes(":thumbsup:")).toBe(":thumbsup:");
    });

    it("should convert shortcodes embedded in text", () => {
      const input = ":wave: Hello! I'm ready :rocket:";
      const result = formatEmojiShortcodes(input);
      expect(result).toContain("👋");
      expect(result).toContain("🚀");
      expect(result).toContain("Hello! I'm ready");
    });

    it("should return text unchanged when no shortcodes are present", () => {
      const input = "Hello, this is plain text.";
      expect(formatEmojiShortcodes(input)).toBe(input);
    });
  });

  describe("emoji shortcodes in formatMarkdown", () => {
    it("should convert emoji shortcodes in formatted output", () => {
      const input = ":wave: Hello **world**";
      const result = formatMarkdown(input);
      expect(result).toContain("👋");
    });

    it("should not convert emoji shortcodes inside inline code", () => {
      const input = "Use `:wave:` for the wave emoji";
      const result = formatMarkdown(input);
      // The inline code content should still have the literal shortcode
      expect(result).toContain(":wave:");
    });

    it("should not convert emoji shortcodes inside code blocks", () => {
      const input = "```\n:wave:\n```";
      const result = formatMarkdown(input);
      // Code block content should preserve the literal shortcode
      expect(result).toContain(":wave:");
    });
  });

  describe("emoji shortcodes in formatMarkdownHybrid", () => {
    it("should convert emoji shortcodes in hybrid formatted output", () => {
      const input = ":rocket: Launch time!";
      const result = formatMarkdownHybrid(input);
      expect(result).toContain("🚀");
    });

    it("should not convert emoji shortcodes inside inline code in hybrid mode", () => {
      const input = "Use `:rocket:` for the rocket emoji";
      const result = formatMarkdownHybrid(input);
      expect(result).toContain(":rocket:");
    });
  });

  describe("formatInlineCode", () => {
    it("should replace backtick-wrapped code with styled output", () => {
      const input = "Use `console.log` to debug";
      const result = formatInlineCode(input);
      expect(result).toContain(codeColor("console.log"));
      // Backticks should be removed in rendered mode
      expect(result).not.toContain("`console.log`");
    });

    it("should handle multiple inline code spans", () => {
      const input = "Compare `foo` and `bar`";
      const result = formatInlineCode(input);
      expect(result).toContain(codeColor("foo"));
      expect(result).toContain(codeColor("bar"));
    });

    it("should not match multi-line backtick content", () => {
      const input = "This `has\nnewline` inside";
      const result = formatInlineCode(input);
      // Should remain unchanged since the regex doesn't match across newlines
      expect(result).toBe(input);
    });
  });

  describe("wrapToWidth", () => {
    it("should wrap long lines at the specified width", () => {
      const input = "a ".repeat(50).trim(); // 99 chars of "a a a a ..."
      const result = wrapToWidth(input, 40);
      const lines = result.split("\n");
      // Every line should be <= 40 visible characters
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(40);
      }
    });

    it("should return empty string for empty input", () => {
      expect(wrapToWidth("", 80)).toBe("");
    });

    it("should return the input unchanged if already shorter than width", () => {
      const input = "short text";
      expect(wrapToWidth(input, 80)).toBe(input);
    });

    it("should enforce a minimum width (no degenerate single-char wrapping)", () => {
      const input = "Hello World, this is a test";
      // Even with width=1, the MIN_WRAP_WIDTH (20) should prevent single-char wrapping
      const result = wrapToWidth(input, 1);
      const lines = result.split("\n");
      // With min width 20, the text should not be wrapped character-by-character
      expect(lines.length).toBeLessThan(input.length);
    });

    it("should preserve existing newlines", () => {
      const input = "line one\nline two\nline three";
      const result = wrapToWidth(input, 80);
      expect(result).toBe(input);
    });

    it("should handle ANSI escape codes without counting them as visible width", () => {
      const styled = "\x1b[1mBold text\x1b[0m and normal text";
      const result = wrapToWidth(styled, 40);
      // Should not wrap since visible content is well under 40 chars
      expect(result.split("\n")).toHaveLength(1);
    });
  });

  describe("getTerminalWidth", () => {
    it("should return a positive number", () => {
      const width = getTerminalWidth();
      expect(width).toBeGreaterThan(0);
    });

    it("should return at least 80 (the default fallback)", () => {
      // In test environments, stdout.columns may be undefined, falling back to 80
      const width = getTerminalWidth();
      expect(width).toBeGreaterThanOrEqual(80);
    });
  });
});
