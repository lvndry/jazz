import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  MarkdownServiceTag,
  MarkdownServiceLive,
  formatMarkdown,
  stripAnsiCodes,
  normalizeBlankLines,
  INITIAL_STREAMING_STATE,
} from "./markdown-service";

// ============================================================================
// Tests
// ============================================================================

describe("MarkdownService", () => {
  describe("formatMarkdown (static)", () => {
    test("formats headings", () => {
      expect(formatMarkdown("# Heading 1")).toContain("Heading 1");
      expect(formatMarkdown("## Heading 2")).toContain("Heading 2");
      expect(formatMarkdown("### Heading 3")).toContain("Heading 3");
    });

    test("formats bold text", () => {
      const result = formatMarkdown("This is **bold** text");
      expect(result).toContain("bold");
    });

    test("formats italic text", () => {
      const result = formatMarkdown("This is *italic* text");
      expect(result).toContain("italic");
    });

    test("formats inline code", () => {
      const result = formatMarkdown("Use the `code` here");
      expect(result).toContain("code");
    });

    test("formats code blocks", () => {
      const result = formatMarkdown("```javascript\nconst x = 1;\n```");
      expect(result).toContain("const x = 1;");
    });

    test("formats bullet lists", () => {
      const result = formatMarkdown("- Item 1\n- Item 2\n- Item 3");
      expect(result).toContain("Item 1");
      expect(result).toContain("Item 2");
      expect(result).toContain("Item 3");
    });

    test("formats numbered lists", () => {
      const result = formatMarkdown("1. First\n2. Second\n3. Third");
      expect(result).toContain("First");
      expect(result).toContain("Second");
      expect(result).toContain("Third");
    });

    test("formats blockquotes", () => {
      const result = formatMarkdown("> This is a quote");
      expect(result).toContain("This is a quote");
    });

    test("formats horizontal rules", () => {
      const result = formatMarkdown("---");
      expect(result.length).toBeGreaterThan(0);
    });

    test("formats links", () => {
      const result = formatMarkdown("[text](https://example.com)");
      expect(result).toContain("text");
      // URL is included in ANSI hyperlink format which may not always show example.com literally
    });

    test("formats strikethrough", () => {
      const result = formatMarkdown("~~deleted~~");
      expect(result).toContain("deleted");
    });
  });

  describe("stripAnsiCodes", () => {
    test("removes ANSI escape sequences", () => {
      const input = "\x1b[31mRed text\x1b[0m";
      const result = stripAnsiCodes(input);
      expect(result).toBe("Red text");
    });

    test("handles text without ANSI codes", () => {
      const input = "Plain text";
      const result = stripAnsiCodes(input);
      expect(result).toBe("Plain text");
    });

    test("removes multiple ANSI codes", () => {
      const input = "\x1b[1m\x1b[34mBold blue\x1b[0m normal";
      const result = stripAnsiCodes(input);
      expect(result).toBe("Bold blue normal");
    });
  });

  describe("normalizeBlankLines", () => {
    test("reduces multiple blank lines to two", () => {
      const input = "Line 1\n\n\n\n\nLine 2";
      const result = normalizeBlankLines(input);
      expect(result).toBe("Line 1\n\nLine 2");
    });

    test("preserves single blank lines", () => {
      const input = "Line 1\n\nLine 2";
      const result = normalizeBlankLines(input);
      expect(result).toBe("Line 1\n\nLine 2");
    });

    test("preserves text without multiple blanks", () => {
      const input = "Line 1\nLine 2\nLine 3";
      const result = normalizeBlankLines(input);
      expect(result).toBe("Line 1\nLine 2\nLine 3");
    });
  });

  describe("Streaming Formatter", () => {
    test("initial state is correct", () => {
      expect(INITIAL_STREAMING_STATE.isInCodeBlock).toBe(false);
      expect(INITIAL_STREAMING_STATE.buffer).toBe("");
    });

    test("streaming formatter via service handles plain text", async () => {
      const program = Effect.gen(function* () {
        const service = yield* MarkdownServiceTag;
        const formatter = yield* service.createStreamingFormatter;
        const result = yield* formatter.append("Hello world");
        return result;
      });

      const runnable = Effect.provide(program, MarkdownServiceLive);
      const result = await Effect.runPromise(runnable);

      // Result should be a FormattedChunk with formatted and state
      expect(result).toBeDefined();
      expect(typeof result.formatted).toBe("string");
      expect(result.state).toBeDefined();
    });

    test("streaming formatter tracks code block state", async () => {
      const program = Effect.gen(function* () {
        const service = yield* MarkdownServiceTag;
        const formatter = yield* service.createStreamingFormatter;

        // Process code block start
        yield* formatter.append("```javascript\n");

        // Check state
        const state = yield* formatter.getState;
        expect(state.isInCodeBlock).toBe(true);

        return state;
      });

      const runnable = Effect.provide(program, MarkdownServiceLive);
      const result = await Effect.runPromise(runnable);

      expect(result.isInCodeBlock).toBe(true);
    });

    test("streaming formatter accumulates content", async () => {
      const program = Effect.gen(function* () {
        const service = yield* MarkdownServiceTag;
        const formatter = yield* service.createStreamingFormatter;

        // Process multiple chunks
        const r1 = yield* formatter.append("Hello ");
        const r2 = yield* formatter.append("world");
        const r3 = yield* formatter.append("!");

        return { r1, r2, r3 };
      });

      const runnable = Effect.provide(program, MarkdownServiceLive);
      const { r1, r2, r3 } = await Effect.runPromise(runnable);

      // Each chunk should produce output
      expect(r1).toBeDefined();
      expect(r2).toBeDefined();
      expect(r3).toBeDefined();
    });
  });

  describe("MarkdownService Layer", () => {
    test("service provides format method", async () => {
      const program = Effect.gen(function* () {
        const service = yield* MarkdownServiceTag;
        const result = yield* service.format("# Test Heading");
        return result;
      });

      const runnable = Effect.provide(program, MarkdownServiceLive);
      const result = await Effect.runPromise(runnable);

      expect(result).toContain("Test Heading");
    });

    test("service provides createStreamingFormatter", async () => {
      const program = Effect.gen(function* () {
        const service = yield* MarkdownServiceTag;
        const formatter = yield* service.createStreamingFormatter;

        expect(formatter.append).toBeDefined();
        expect(formatter.getState).toBeDefined();
        expect(formatter.reset).toBeDefined();
        expect(formatter.flush).toBeDefined();

        return formatter;
      });

      const runnable = Effect.provide(program, MarkdownServiceLive);
      const formatter = await Effect.runPromise(runnable);

      // Test the streaming formatter
      const result = await Effect.runPromise(formatter.append("Hello world"));
      expect(result).toBeDefined();
    });

    test("streaming formatter processes multiple chunks", async () => {
      const program = Effect.gen(function* () {
        const service = yield* MarkdownServiceTag;
        const formatter = yield* service.createStreamingFormatter;

        const out1 = yield* formatter.append("# Hello ");
        const out2 = yield* formatter.append("World");

        return { out1, out2 };
      });

      const runnable = Effect.provide(program, MarkdownServiceLive);
      const { out1 } = await Effect.runPromise(runnable);

      expect(out1).toBeDefined();
    });

    test("streaming formatter can be reset", async () => {
      const program = Effect.gen(function* () {
        const service = yield* MarkdownServiceTag;
        const formatter = yield* service.createStreamingFormatter;

        // Process some content to get into code block state
        yield* formatter.append("```js\nconst x = 1;\n");

        // State should be in code block
        const stateBefore = yield* formatter.getState;
        expect(stateBefore.isInCodeBlock).toBe(true);

        // Reset
        yield* formatter.reset;

        // State should be initial
        const stateAfter = yield* formatter.getState;
        expect(stateAfter.isInCodeBlock).toBe(false);

        return true;
      });

      const runnable = Effect.provide(program, MarkdownServiceLive);
      const result = await Effect.runPromise(runnable);

      expect(result).toBe(true);
    });
  });

  describe("Edge Cases", () => {
    test("handles empty string", () => {
      const result = formatMarkdown("");
      expect(result).toBe("");
    });

    test("handles text with only whitespace", () => {
      const result = formatMarkdown("   ");
      expect(result).toBe("   ");
    });

    test("handles nested formatting", () => {
      const result = formatMarkdown("**bold with `code` inside**");
      expect(result).toContain("bold");
      expect(result).toContain("code");
    });

    test("handles incomplete code blocks gracefully", () => {
      // Incomplete code block shouldn't crash
      const result = formatMarkdown("```javascript\nconst x = 1;");
      expect(result).toContain("const x = 1;");
    });

    test("handles special characters", () => {
      const result = formatMarkdown("Special: < > & \" '");
      expect(stripAnsiCodes(result)).toContain("<");
      expect(stripAnsiCodes(result)).toContain(">");
      expect(stripAnsiCodes(result)).toContain("&");
    });
  });
});
