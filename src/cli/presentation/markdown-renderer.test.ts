import { beforeEach, describe, expect, it } from "bun:test";
import chalk from "chalk";
import { MarkdownRenderer } from "./markdown-renderer";

describe("MarkdownRenderer", () => {
  beforeEach(() => {
    MarkdownRenderer.resetStreamingBuffer();
  });

  describe("renderChunk", () => {
    it("should render plain text correctly", () => {
      const text = "Hello world";
      const result = MarkdownRenderer.renderChunk(text, 0);
      expect(result).toBe("Hello world");
    });

    it("should render bold text correctly", () => {
      const text = "**Bold**";
      MarkdownRenderer.renderChunk(text, 0);
      const result = MarkdownRenderer.flushBuffer();
      expect(result).toBe(chalk.bold("Bold"));
    });

    it("should render italic text correctly", () => {
      const text = "*Italic*";
      MarkdownRenderer.renderChunk(text, 0);
      const result = MarkdownRenderer.flushBuffer();
      expect(result).toBe(chalk.italic("Italic"));
    });

    it("should render inline code correctly", () => {
      const text = "`code`";
      MarkdownRenderer.renderChunk(text, 0);
      const result = MarkdownRenderer.flushBuffer();
      expect(result).toBe(chalk.cyan("code"));
    });

    it("should render headers correctly", () => {
      const text = "## Header\n";
      const result = MarkdownRenderer.renderChunk(text, 0);
      expect(result).toBe(chalk.bold.blue.underline("Header") + "\n");
    });

    it("should render blockquotes correctly", () => {
      const text = "> Quote\n";
      const result = MarkdownRenderer.renderChunk(text, 0);
      expect(result).toBe(chalk.gray("│ Quote") + "\n");
    });

    it("should render unordered lists correctly", () => {
      const text = "- Item\n";
      const result = MarkdownRenderer.renderChunk(text, 0);
      expect(result).toBe(`  ${chalk.yellow("-")} Item\n`);
    });

    it("should render ordered lists correctly", () => {
      const text = "1. Item\n";
      const result = MarkdownRenderer.renderChunk(text, 0);
      expect(result).toBe(`  ${chalk.yellow("1.")} Item\n`);
    });

    it("should render horizontal rules correctly", () => {
      const text = "---\n";
      const result = MarkdownRenderer.renderChunk(text, 0);
      // The regex replacement consumes the newline if matched with $gm
      expect(result).toBe(chalk.gray("────────────────────────────────────────"));
    });

    it("should render code blocks statefully", () => {
      // Start code block
      const chunk1 = "```typescript\n";
      const result1 = MarkdownRenderer.renderChunk(chunk1, 0);
      expect(result1).toBe(chalk.yellow("```typescript") + "\n");

      // Content inside code block (should be cyan)
      const chunk2 = "const x = 1;\n";
      const result2 = MarkdownRenderer.renderChunk(chunk2, 0);
      // The implementation colors the entire chunk including the newline
      expect(result2).toBe(chalk.cyan("const x = 1;\n"));

      // End code block
      const chunk3 = "```\n";
      const result3 = MarkdownRenderer.renderChunk(chunk3, 0);
      expect(result3).toBe(chalk.yellow("```") + "\n");

      // Content outside code block (plain)
      const chunk4 = "Plain text\n";
      const result4 = MarkdownRenderer.renderChunk(chunk4, 0);
      expect(result4).toBe("Plain text\n");
    });

    it("should buffer partial headers", () => {
      // Chunk 1: "##" (should be buffered)
      const chunk1 = "##";
      const result1 = MarkdownRenderer.renderChunk(chunk1, 0);
      expect(result1).toBe("");

      // Chunk 2: " Header\n" (should complete the header)
      const chunk2 = " Header\n";
      const result2 = MarkdownRenderer.renderChunk(chunk2, 0);
      expect(result2).toBe(chalk.bold.blue.underline("Header") + "\n");
    });

    it("should buffer partial headers with leading spaces", () => {
      // Chunk 1: "  ##" (should be buffered)
      const chunk1 = "  ##";
      const result1 = MarkdownRenderer.renderChunk(chunk1, 0);
      expect(result1).toBe("");

      // Chunk 2: " Header\n" (should complete the header)
      const chunk2 = " Header\n";
      const result2 = MarkdownRenderer.renderChunk(chunk2, 0);
      expect(result2).toBe(chalk.bold.blue.underline("Header") + "\n");
    });

    it("should buffer partial bold markers", () => {
      // Chunk 1: "**" (should be buffered because it ends with marker)
      const chunk1 = "**";
      const result1 = MarkdownRenderer.renderChunk(chunk1, 0);
      expect(result1).toBe("");

      // Chunk 2: "Bold**" (should be buffered because it ends with marker)
      const chunk2 = "Bold**";
      const result2 = MarkdownRenderer.renderChunk(chunk2, 0);
      expect(result2).toBe("");

      // Flush buffer to get the result
      const result3 = MarkdownRenderer.flushBuffer();
      expect(result3).toBe(chalk.bold("Bold"));
    });

    it("should handle split headers across multiple chunks", () => {
      // Chunk 1: "##"
      expect(MarkdownRenderer.renderChunk("##", 0)).toBe("");
      // Chunk 2: " Hea"
      expect(MarkdownRenderer.renderChunk(" Hea", 0)).toBe("");
      // Chunk 3: "der\n"
      expect(MarkdownRenderer.renderChunk("der\n", 0)).toBe(
        chalk.bold.blue.underline("Header") + "\n",
      );
    });

    it("should handle multiple lines correctly", () => {
      const text = "Line 1\nLine 2\n";
      const result = MarkdownRenderer.renderChunk(text, 0);
      expect(result).toBe("Line 1\nLine 2\n");
    });

    it("should handle mixed content with split header", () => {
      // Chunk 1: "Text\n##"
      const chunk1 = "Text\n##";
      const result1 = MarkdownRenderer.renderChunk(chunk1, 0);
      // Should return "Text\n" and buffer "##"
      expect(result1).toBe("Text\n");

      // Chunk 2: " Header\n"
      const chunk2 = " Header\n";
      const result2 = MarkdownRenderer.renderChunk(chunk2, 0);
      expect(result2).toBe(chalk.bold.blue.underline("Header") + "\n");
    });
  });

  describe("flushBuffer", () => {
    it("should flush remaining buffer", () => {
      // Manually set buffer to ensure we have something to flush
      // @ts-expect-error Accessing private property for testing
      MarkdownRenderer.streamingBuffer = "Some text";
      const result = MarkdownRenderer.flushBuffer();
      expect(result).toBe("Some text");
    });

    it("should flush partial header as styled header if stream ends", () => {
      MarkdownRenderer.renderChunk("## Partial", 0); // buffers because it looks like header
      const result = MarkdownRenderer.flushBuffer();
      // If the stream ends, we process what we have.
      // Since "## Partial" matches the header regex (start of string), it gets styled.
      expect(result).toBe(chalk.bold.blue.underline("Partial"));
    });
  });
});
