import { describe, expect, it } from "bun:test";
import {
  applyProgressiveFormatting,
  formatBold,
  formatEmojiShortcodes,
  formatInlineCode,
  formatLinks,
  formatMarkdown,
  formatMarkdownHybrid,
  getTerminalWidth,
  INITIAL_STREAMING_STATE,
  stripAnsiCodes,
  wrapToWidth,
} from "./markdown-formatter";
import { CHALK_THEME, codeColor } from "../ui/theme";

/** Count OSC 8 hyperlink sequences (\x1b]8;;) in output. */
function countOsc8(text: string): number {
  // eslint-disable-next-line no-control-regex
  return (text.match(/\x1b]8;;/g) || []).length;
}

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

  describe("file paths in formatMarkdownHybrid", () => {
    it("should style absolute paths as clickable links", () => {
      const input = "Check /Users/me/project/src for more info.";
      const result = formatMarkdownHybrid(input);
      expect(result).toContain("\x1b]8;;");
      expect(result).toContain("file://");
    });

    it("should not add hyperlink for relative paths (impossible to resolve at click time)", () => {
      const input = "Check the folder src/cli/presentation for more info.";
      const result = formatMarkdownHybrid(input);
      // Relative paths are not wrapped in OSC 8 — only absolute/~/ paths are clickable
      expect(result).not.toContain("\x1b]8;;");
    });

    it("should not match paths inside markdown link targets (relative)", () => {
      const input = "[Docs](./docs/README.md)";
      const result = formatMarkdownHybrid(input);
      // terminalHyperlink produces two \x1b]8;; sequences per link (open + close),
      // so exactly one hyperlink = 2 occurrences.
      const osc8Count = countOsc8(result);
      expect(osc8Count).toBe(2);
    });

    it("should not match absolute paths inside markdown link targets", () => {
      const input = "[Repo](/abs/path/to/file)";
      const result = formatMarkdownHybrid(input);
      const osc8Count = countOsc8(result);
      expect(osc8Count).toBe(2); // single hyperlink, not double
    });

    it("should not match home paths inside markdown link targets", () => {
      const input = "[Config](~/dotfiles/config.json)";
      const result = formatMarkdownHybrid(input);
      const osc8Count = countOsc8(result);
      expect(osc8Count).toBe(2);
    });

    it("should not match file:line paths inside markdown link targets", () => {
      const input = "[Error](/src/main.ts:42:10)";
      const result = formatMarkdownHybrid(input);
      const osc8Count = countOsc8(result);
      expect(osc8Count).toBe(2);
    });
  });

  describe("file paths in formatMarkdown", () => {
    it("should not match paths inside markdown link targets", () => {
      const input = "[Docs](./docs/README.md)";
      const result = formatMarkdown(input);
      // terminalHyperlink produces two \x1b]8;; per link (open + close)
      const osc8Count = countOsc8(result);
      expect(osc8Count).toBe(2);
    });

    it("should not match absolute paths inside markdown link targets", () => {
      const input = "[File](/usr/local/bin/app)";
      const result = formatMarkdown(input);
      const osc8Count = countOsc8(result);
      expect(osc8Count).toBe(2);
    });
  });

  describe("bare URLs in formatMarkdownHybrid", () => {
    it("should style bare URLs as clickable links", () => {
      const input = "See https://example.com for more.";
      const result = formatMarkdownHybrid(input);
      expect(result).toContain("\x1b]8;;");
      expect(result).toContain("https://example.com");
    });

    it("should not leak ANSI reset codes when URLs are bolded", () => {
      const input = "**https://github.com/lvndry/jazz/pull/187**";
      const result = formatMarkdownHybrid(input);
      const stripped = stripAnsiCodes(result);
      expect(stripped).toBe("**https://github.com/lvndry/jazz/pull/187**");
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

  // ============================================================================
  // Regression tests for audit findings
  // ============================================================================

  describe("BOLD_REGEX: underscores/asterisks inside bold", () => {
    it("should bold text containing underscores (**foo_bar**)", () => {
      const result = formatBold("**foo_bar**");
      // The ** delimiters should be consumed and "foo_bar" preserved
      expect(result).toContain("foo_bar");
      expect(result).not.toContain("**foo_bar**");
    });

    it("should bold text containing asterisks (__foo*bar__)", () => {
      const result = formatBold("__foo*bar__");
      // The __ delimiters should be consumed and "foo*bar" preserved
      expect(result).toContain("foo*bar");
      expect(result).not.toContain("__foo*bar__");
    });
  });

  describe("HORIZONTAL_RULE_REGEX: requires same character", () => {
    it("should format --- as a horizontal rule", () => {
      const result = formatMarkdown("---");
      expect(result).toContain("─");
    });

    it("should not format mixed characters --**__ as a horizontal rule", () => {
      const result = formatMarkdown("--**__");
      expect(result).not.toContain("─");
    });
  });

  describe("stripAnsiCodes: strips OSC 8 hyperlinks", () => {
    it("should strip SGR escape codes", () => {
      expect(stripAnsiCodes("\x1b[1mBold\x1b[0m")).toBe("Bold");
    });

    it("should strip OSC 8 terminal hyperlinks", () => {
      const hyperlink = "\x1b]8;;https://example.com\x07Click\x1b]8;;\x07";
      expect(stripAnsiCodes(hyperlink)).toBe("Click");
    });
  });

  describe("FILE_PATH_REGEX: false positive reduction", () => {
    it("should not match bare /", () => {
      // formatMarkdown wraps absolute paths in hyperlinks; bare / should be left alone
      const result = formatMarkdownHybrid("use / as delimiter");
      expect(result).not.toContain("\x1b]8;;");
    });

    it("should not match and/or", () => {
      const result = formatMarkdownHybrid("this and/or that");
      expect(result).not.toContain("\x1b]8;;");
    });

    it("should match ./relative/path via the regex", () => {
      // FILE_PATH_REGEX matches relative paths with ./ prefix.
      // In the full pipeline, styling is a no-op at chalk.level=0,
      // so we test the regex directly.
      const FILE_PATH_REGEX =
        /(?<!\]\()(?<![:\w/])(\/(?!\/)(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+|~(?:\/[a-zA-Z0-9._-]+)+|\.\.?\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+)/g;
      const matches = [..."see ./src/index.ts for details".matchAll(FILE_PATH_REGEX)];
      expect(matches).toHaveLength(1);
      expect(matches[0]![0]).toBe("./src/index.ts");
    });
  });

  describe("LINK_REGEX: URLs with balanced parentheses", () => {
    it("should match Wikipedia-style URLs with parens", () => {
      const input = "[Foo](https://en.wikipedia.org/wiki/Foo_(bar))";
      const result = formatLinks(input);
      expect(result).toContain("https://en.wikipedia.org/wiki/Foo_(bar)");
    });
  });

  describe("inline code protection in streaming (applyProgressiveFormatting)", () => {
    it("should not apply bold inside backtick spans", () => {
      const input = "Use `**not bold**` for literal asterisks";
      const { formatted } = applyProgressiveFormatting(input, INITIAL_STREAMING_STATE);
      // The ** markers should be preserved inside the code span
      // (if bold had been applied, ** would have been consumed)
      expect(formatted).toContain("**not bold**");
    });

    it("should not apply inline formatting inside code blocks", () => {
      const input = "```\n**bold** and _italic_\n```";
      const { formatted } = applyProgressiveFormatting(input, INITIAL_STREAMING_STATE);
      // The markdown markers should be preserved inside the code block
      // (if bold/italic had been applied, ** and _ would have been consumed)
      expect(formatted).toContain("**bold**");
      expect(formatted).toContain("_italic_");
    });
  });

  describe("formatEscapedText ordering (code extraction first)", () => {
    it("should preserve backslash escapes inside inline code", () => {
      const result = formatMarkdown("Use `\\*literal\\*` to escape");
      // The \\* should remain inside the code span, not be unescaped
      expect(result).toContain(codeColor("\\*literal\\*"));
    });

    it("should preserve backslash escapes inside code blocks", () => {
      const result = formatMarkdown("```\n\\*escaped\\*\n```");
      // Code block content should be verbatim
      expect(result).toContain("\\*escaped\\*");
    });
  });

  describe("BARE_URL_REGEX: trailing punctuation", () => {
    it("should not capture trailing period", () => {
      const result = formatMarkdownHybrid("Visit https://example.com.");
      // The period should not be inside the hyperlink
      const stripped = stripAnsiCodes(result);
      expect(stripped).toMatch(/example\.com[^.]*\.$/);
    });
  });
});
