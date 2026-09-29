import { describe, expect, it } from "bun:test";
import { getTerminalWidth, stripAnsiCodes, wrapToWidth } from "./markdown-formatter";

/** Build an OSC 8 terminal hyperlink the same way the shared markdown adapter does. */
function hyperlink(text: string, url: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

describe("markdown-formatter", () => {
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

  describe("wrapToWidth — long hyperlink (URL) wrapping", () => {
    /** Non-empty OSC 8 targets (excludes the empty `\x1b]8;;\x07` closer). */
    const linkTargets = (text: string): string[] => {
      // eslint-disable-next-line no-control-regex
      const matches = [...text.matchAll(/\x1b\]8;;([^\x07]*)\x07/g)];
      return matches.map((m) => m[1]!).filter((t) => t !== "");
    };
    /** Visible text with wrap newlines removed — what the URL "reads as" unwrapped. */
    const visibleUnwrapped = (text: string): string => stripAnsiCodes(text).replace(/\n/g, "");

    // A real-world offender: a very long slug with only a handful of separators.
    const sparseUrl =
      "https://www.mediacongo.net/publireportage-reportage-114852fpilafermeavicolecongoufdelubumbashimerite-ladiversificationdesesactivitesmartinmudimutshisekedi.html";
    // A separator-rich slug that should break cleanly at hyphens.
    const hyphenUrl =
      "https://en.wikipedia.org/wiki/List-of-the-largest-suspension-bridges-in-the-world-by-total-length";

    it("keeps every OSC 8 target byte-for-byte identical to the source URL (no A-shows-B)", () => {
      for (const url of [sparseUrl, hyphenUrl]) {
        for (const width of [30, 50, 80, 120]) {
          const wrapped = wrapToWidth(`Source: ${hyperlink(url, url)}`, width);
          const targets = linkTargets(wrapped);
          expect(targets.length).toBeGreaterThan(0);
          for (const target of targets) expect(target).toBe(url);
        }
      }
    });

    it("preserves the full URL in the visible text (never truncates or relabels)", () => {
      for (const url of [sparseUrl, hyphenUrl]) {
        for (const width of [30, 50, 80, 120]) {
          const wrapped = wrapToWidth(`Source: ${hyperlink(url, url)}`, width);
          expect(visibleUnwrapped(wrapped)).toBe(`Source: ${url}`);
        }
      }
    });

    it("keeps every wrapped line within the width", () => {
      for (const url of [sparseUrl, hyphenUrl]) {
        for (const width of [30, 50, 80, 120]) {
          const wrapped = wrapToWidth(`Source: ${hyperlink(url, url)}`, width);
          for (const line of stripAnsiCodes(wrapped).split("\n")) {
            expect(line.length).toBeLessThanOrEqual(width);
          }
        }
      }
    });

    it("prefers separator boundaries over arbitrary mid-token breaks", () => {
      const wrapped = wrapToWidth(`Source: ${hyperlink(hyphenUrl, hyphenUrl)}`, 50);
      const lines = stripAnsiCodes(wrapped).split("\n");
      // More than one line (it must wrap) and every non-final line ends at a separator.
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines.slice(0, -1)) {
        expect("/-._~?#&=+,;@%").toContain(line.at(-1)!);
      }
    });

    it("still hard-breaks a separator-free run that exceeds the width", () => {
      const noSep = "https://example.com/" + "a".repeat(200);
      const wrapped = wrapToWidth(hyperlink(noSep, noSep), 40);
      const lines = stripAnsiCodes(wrapped).split("\n");
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
      expect(visibleUnwrapped(wrapped)).toBe(noSep);
      expect(linkTargets(wrapped).every((t) => t === noSep)).toBe(true);
    });

    it("leaves a URL that fits as a single unbroken hyperlink", () => {
      const shortUrl = "https://example.com/page";
      const wrapped = wrapToWidth(`See ${hyperlink(shortUrl, shortUrl)}`, 80);
      expect(wrapped.split("\n")).toHaveLength(1);
      expect(linkTargets(wrapped)).toEqual([shortUrl]);
    });

    it("does not apply separator-preference to non-link text (only hyperlinks)", () => {
      // A long, separator-rich token that is NOT a hyperlink must still hard-break
      // at the column boundary — separator-preference is scoped to OSC 8 links.
      const token = "a-b-c-d-".repeat(20); // 160 chars, hyphens every 2 chars, no URL scheme
      const wrapped = wrapToWidth(token, 40);
      const lines = wrapped.split("\n");
      // Hard break fills lines to the full width (would be shorter if it broke at hyphens).
      expect(lines[0]!.length).toBe(40);
      expect(wrapped.replace(/\n/g, "")).toBe(token);
    });
  });

  describe("getTerminalWidth", () => {
    it("should return a positive number", () => {
      const width = getTerminalWidth();
      expect(width).toBeGreaterThan(0);
    });

    it("should return at least 20 (handles thin text pseudo-terminals)", () => {
      // In test environments, stdout.columns may be undefined or small, falling back to 80 or using actual
      const width = getTerminalWidth();
      expect(width).toBeGreaterThanOrEqual(20);
    });
  });

  describe("stripAnsiCodes: strips OSC 8 hyperlinks", () => {
    it("should strip SGR escape codes", () => {
      expect(stripAnsiCodes("\x1b[1mBold\x1b[0m")).toBe("Bold");
    });

    it("should strip OSC 8 terminal hyperlinks", () => {
      const link = hyperlink("Click", "https://example.com");
      expect(stripAnsiCodes(link)).toBe("Click");
    });
  });
});
