import { describe, expect, it } from "bun:test";
import { MarkdownRenderer } from "./markdown-renderer";

describe("MarkdownRenderer.findSafeFlushIndex", () => {
  // Helper to test safe index
  const testSafeIndex = (text: string, expectedIndex: number) => {
    expect(MarkdownRenderer.findSafeFlushIndex(text)).toBe(expectedIndex);
  };

  it("should return full length for plain text", () => {
    testSafeIndex("Hello world", 11);
    testSafeIndex("Simple text with no markdown", 28);
  });

  describe("Bold (**)", () => {
    it("should handle complete bold tags", () => {
      testSafeIndex("This is **bold** text", 21);
      testSafeIndex("**Bold** at start", 17);
      testSafeIndex("At end **bold**", 15);
    });

    it("should cut at incomplete bold start", () => {
      testSafeIndex("This is **bo", 8); // "This is "
      testSafeIndex("**Bold", 0);
    });

    it("should handle multiple bold tags", () => {
      testSafeIndex("**One** and **Two**", 19);
      testSafeIndex("**One** and **Tw", 12); // "**One** and "
    });
  });

  describe("Italic (*)", () => {
    it("should handle complete italic tags", () => {
      testSafeIndex("This is *italic* text", 21);
      testSafeIndex("*Italic* at start", 17);
    });

    it("should cut at incomplete italic start", () => {
      testSafeIndex("This is *ita", 8); // "This is "
      testSafeIndex("*Ita", 0);
    });

    it("should handle multiple italic tags", () => {
      testSafeIndex("*One* and *Two*", 15);
      testSafeIndex("*One* and *Tw", 10); // "*One* and "
    });

    it("should distinguish * from **", () => {
      // "**" is one token for bold, not two italics
      // "Text **bold**" -> 0 italics, 2 bolds (even) -> safe
      testSafeIndex("Text **bold**", 13);

      // "Text *italic*" -> 2 italics (even) -> safe
      testSafeIndex("Text *italic*", 13);
    });
  });

  describe("Italic (_)", () => {
    it("should handle complete underscore italic", () => {
      testSafeIndex("This is _italic_ text", 21);
    });

    it("should cut at incomplete underscore", () => {
      testSafeIndex("This is _ita", 8);
    });
  });

  describe("Code (`)", () => {
    it("should handle complete inline code blocks", () => {
      testSafeIndex("This is `code` text", 19);
    });

    it("should cut at incomplete inline code block", () => {
      testSafeIndex("This is `co", 8);
      testSafeIndex("`Co", 0);
    });

    it("should handle multiple inline code blocks", () => {
      testSafeIndex("`One` and `Two`", 15);
      testSafeIndex("`One` and `Tw", 10);
    });
  });

  describe("Fenced code blocks (```)", () => {
    it("should handle complete fenced code blocks", () => {
      // "```\ncode\n```" = 12 chars (3+1+4+1+3)
      testSafeIndex("```\ncode\n```", 12);
      // "Text ```\ncode\n```" = 17 chars (5+3+1+4+1+3)
      testSafeIndex("Text ```\ncode\n```", 17);
    });

    it("should cut at incomplete fenced code block", () => {
      testSafeIndex("```\ncode", 0); // Can't flush anything before unclosed block
      testSafeIndex("Text ```\ncode", 5); // Can flush "Text " but not the block
    });

    it("should handle fenced code blocks with language identifiers", () => {
      // Complete block with language: "```typescript\ncode\n```" = 22 chars
      testSafeIndex("```typescript\ncode\n```", 22);
      // "```python\ndef hello():\n    pass\n```" = 35 chars
      testSafeIndex("```python\ndef hello():\n    pass\n```", 35);

      // Incomplete block with language - should prevent flushing
      testSafeIndex("```typescript\ncode", 0);
      testSafeIndex("Text ```typescript\ncode", 5); // Can flush "Text " but not block
      testSafeIndex("```python\ndef hello():\n    pass", 0);
    });

    it("should handle multiple fenced code blocks", () => {
      // "```ts\ncode1\n```\n```js\ncode2\n```" = 31 chars
      testSafeIndex("```ts\ncode1\n```\n```js\ncode2\n```", 31);
      // "```ts\ncode1\n```\n```js\ncode2" = 27 chars, but second block incomplete
      // Function finds last ``` at position 16 (start of second incomplete block)
      // So it returns 16, meaning we can flush first 16 chars: "```ts\ncode1\n```\n```"
      testSafeIndex("```ts\ncode1\n```\n```js\ncode2", 16);
    });

    it("should handle fenced code blocks with language and metadata", () => {
      // "```typescript:file.ts\ncode\n```" = 30 chars
      testSafeIndex("```typescript:file.ts\ncode\n```", 30);
      testSafeIndex("```typescript:file.ts\ncode", 0);
    });
  });

  describe("Links ([text](url))", () => {
    it("should handle complete links", () => {
      testSafeIndex("Click [here](https://example.com)", 33);
    });

    it("should cut at incomplete link start [", () => {
      testSafeIndex("Click [he", 6);
    });

    it("should cut at incomplete link middle ](", () => {
      // Logic: lastIndexOf("[") is found. closingParen ")" search from there.
      // If ")" is missing, it cuts at "[".
      testSafeIndex("Click [here](htt", 6);
    });

    it("should cut at incomplete link bracket ]", () => {
      // "[here]" -> lastIndexOf("[") is 0. indexOf(")") is -1.
      // So it cuts at 0.
      testSafeIndex("Click [here]", 6);
    });

    it("should handle multiple links", () => {
      testSafeIndex("[One](u1) and [Two](u2)", 23);
      testSafeIndex("[One](u1) and [Tw", 14); // "[One](u1) and "
    });
  });

  describe("Mixed constructs", () => {
    it("should handle mixed safe constructs", () => {
      testSafeIndex("**Bold** and *Italic* and `Code`", 32);
    });

    it("should cut at the earliest incomplete construct", () => {
      // "**Bold** and *Italic" -> Bold is safe, Italic is not.
      // Cut at *
      testSafeIndex("**Bold** and *Italic", 13); // "**Bold** and "
    });

    it("should handle nested-looking constructs (simple logic)", () => {
      // The current logic is simple regex counting, it doesn't parse nesting deeply.
      // But let's see behavior.
      // "Text **bold with *italic* inside**"
      // Bolds: 2 (even). Italics: 2 (even). Safe.
      testSafeIndex("Text **bold with *italic* inside**", 34);
    });
  });

  describe("Headings (#, ##, ###, etc.)", () => {
    it("should handle complete headings (with newline)", () => {
      // Complete headings end with newline, so heading check is skipped
      // But we check other constructs - these should all be safe
      testSafeIndex("# Heading 1\n", 12);
      testSafeIndex("## Heading 2\n", 13);
      testSafeIndex("### Heading 3\n", 14);
      // "Text\n# Heading\nMore" = 19 chars, last line "More" is not a heading, so safe
      testSafeIndex("Text\n# Heading\nMore", 19);
    });

    it("should cut at incomplete headings (no newline)", () => {
      // Incomplete heading at start
      testSafeIndex("# Head", 0);
      testSafeIndex("## Head", 0);
      testSafeIndex("### Head", 0);

      // Incomplete heading after text
      // "Text\n# Head" = 11 chars, last line "# Head" is incomplete heading, start at position 5
      testSafeIndex("Text\n# Head", 5);
      testSafeIndex("Text\n## Head", 5);
      testSafeIndex("Text\n### Head", 5);
    });

    it("should handle multiple headings", () => {
      // "# H1\n## H2\n### H3\n" = 18 chars, ends with newline so safe
      testSafeIndex("# H1\n## H2\n### H3\n", 18);
      // "# H1\n## H2\n### H" = 16 chars, last line "### H" is incomplete heading
      // Start of last line is after "## H2\n" = position 11
      testSafeIndex("# H1\n## H2\n### H", 11);
    });

    it("should distinguish headings from other # usage", () => {
      // "Text with # symbol" = 18 chars, no newline, last line doesn't match heading pattern
      testSafeIndex("Text with # symbol", 18);
      // "Text with # symbol here" = 23 chars, no newline, last line doesn't match heading pattern
      testSafeIndex("Text with # symbol here", 23);
      // "Text\n# Heading" = 13 chars, last line "# Heading" is incomplete heading, start at position 5
      testSafeIndex("Text\n# Heading", 5);
      // "Text\n# Heading\n" = 15 chars, ends with newline so heading check skipped, safe
      testSafeIndex("Text\n# Heading\n", 15);
    });

    it("should handle headings with markdown inside", () => {
      // "# Heading with **bold**\n" = 24 chars, ends with newline, but has incomplete bold
      // Bold check: "**bold**" has 2 ** (even), so bold is complete
      // Heading check skipped (ends with newline)
      testSafeIndex("# Heading with **bold**\n", 24);
      // "# Heading with **bold" = 22 chars, incomplete heading, start at position 0
      testSafeIndex("# Heading with **bold", 0);
      // "Text\n# Heading with *italic" = 26 chars, last line is incomplete heading, start at position 5
      testSafeIndex("Text\n# Heading with *italic", 5);
    });
  });

  describe("Blockquotes (>)", () => {
    it("should handle complete blockquotes (with newline)", () => {
      // Complete blockquote ends with newline, so blockquote check is skipped
      testSafeIndex("> Quote text\n", 13);
      // "> Quote with **bold**\n" = 22 chars, ends with newline so safe
      testSafeIndex("> Quote with **bold**\n", 22);
      // "Text\n> Quote\nMore" = 17 chars, last line "More" is not a blockquote, so safe
      testSafeIndex("Text\n> Quote\nMore", 17);
    });

    it("should cut at incomplete blockquotes (no newline)", () => {
      // Incomplete blockquote at start
      testSafeIndex("> Quote", 0);
      testSafeIndex(">Quote", 0); // No space after >
      testSafeIndex("> Quote text", 0);

      // Incomplete blockquote after text
      // "Text\n> Quote" = 12 chars, last line "> Quote" is incomplete blockquote, start at position 5
      testSafeIndex("Text\n> Quote", 5);
      testSafeIndex("Text\n>Quote", 5);
    });

    it("should handle multiple blockquote lines", () => {
      // "> Line 1\n> Line 2\n> Line 3\n" = 27 chars, ends with newline so safe
      testSafeIndex("> Line 1\n> Line 2\n> Line 3\n", 27);
      // "> Line 1\n> Line 2\n> Line 3" = 26 chars, last line is incomplete blockquote
      // Start of last line is after "> Line 2\n" = position 18
      testSafeIndex("> Line 1\n> Line 2\n> Line 3", 18);
    });

    it("should handle blockquotes with markdown inside", () => {
      // "> Quote with **bold**\n" = 22 chars, ends with newline, bold is complete
      // Blockquote check skipped (ends with newline)
      testSafeIndex("> Quote with **bold**\n", 22);
      // "> Quote with **bold" = 21 chars, incomplete blockquote, start at position 0
      testSafeIndex("> Quote with **bold", 0);
      // "Text\n> Quote with *italic" = 25 chars, last line is incomplete blockquote, start at position 5
      testSafeIndex("Text\n> Quote with *italic", 5);
    });

    it("should distinguish blockquotes from other > usage", () => {
      // "Text with > symbol" = 18 chars, no newline, last line doesn't match blockquote pattern
      // (blockquote must be at start of line)
      testSafeIndex("Text with > symbol", 18);
      // "Text\n> Quote\n" = 13 chars, ends with newline so blockquote check skipped, safe
      testSafeIndex("Text\n> Quote\n", 13);
    });

    it("should handle blockquotes with or without space after >", () => {
      // Both patterns should work: ">text" and "> text"
      testSafeIndex(">text\n", 6);
      testSafeIndex("> text\n", 7);
      testSafeIndex(">text", 0);
      testSafeIndex("> text", 0);
    });
  });

  describe("Complex/Edge cases", () => {
    it("should handle text ending with special chars", () => {
      // "Text ending with *"
      // Italics count: 1. Cut at *.
      testSafeIndex("Text ending with *", 17);

      // "Text ending with **"
      // Bolds count: 1. Cut at **.
      testSafeIndex("Text ending with **", 17);
    });

    it("should handle incomplete link with other markdown before it", () => {
      // "**Bold** [Link", cut at [
      testSafeIndex("**Bold** [Link", 9);
    });
  });
});
