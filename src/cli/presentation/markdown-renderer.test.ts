import { beforeEach, describe, expect, it } from "bun:test";
import chalk from "chalk";
import { Effect } from "effect";
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
      // Horizontal rules now include a newline at the end
      expect(result).toBe(chalk.gray("────────────────────────────────────────") + "\n");
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

    it("should properly reset code block state after closing fence", () => {
      // Start and end code block in same chunk
      const chunk1 = "```typescript\nconst x = 1;\n```\n";
      const result1 = MarkdownRenderer.renderChunk(chunk1, 0);
      const lines = result1.split("\n");
      expect(lines[0]).toBe(chalk.yellow("```typescript"));
      expect(lines[1]).toBe(chalk.cyan("const x = 1;"));
      expect(lines[2]).toBe(chalk.yellow("```"));

      // Next chunk should be plain (not cyan)
      const chunk2 = "Normal text after code block\n";
      const result2 = MarkdownRenderer.renderChunk(chunk2, 0);
      expect(result2).toBe("Normal text after code block\n");
    });

    it("should handle multiple code blocks in sequence", () => {
      // First code block
      const chunk1 = "```typescript\nconst x = 1;\n```\n";
      MarkdownRenderer.renderChunk(chunk1, 0);

      // Second code block
      const chunk2 = "```python\nprint('hello')\n```\n";
      const result2 = MarkdownRenderer.renderChunk(chunk2, 0);
      const lines = result2.split("\n");
      expect(lines[0]).toBe(chalk.yellow("```python"));
      expect(lines[1]).toBe(chalk.cyan("print('hello')"));
      expect(lines[2]).toBe(chalk.yellow("```"));

      // Text after should be plain
      const chunk3 = "Normal text\n";
      const result3 = MarkdownRenderer.renderChunk(chunk3, 0);
      expect(result3).toBe("Normal text\n");
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

    it("should render strikethrough text correctly", () => {
      const text = "~~Strikethrough~~\n";
      const result = MarkdownRenderer.renderChunk(text, 0);
      expect(result).toBe(chalk.strikethrough("Strikethrough") + "\n");
    });

    it("should render task lists correctly", () => {
      const text = "- [ ] Unchecked task\n- [x] Checked task\n- [X] Checked task uppercase\n";
      const result = MarkdownRenderer.renderChunk(text, 0);
      const lines = result.split("\n");
      expect(lines[0]).toBe(`  ${chalk.gray("○")} Unchecked task`);
      expect(lines[1]).toBe(`  ${chalk.green("✓")} Checked task`);
      expect(lines[2]).toBe(`  ${chalk.green("✓")} Checked task uppercase`);
    });

    it("should render nested unordered lists correctly", () => {
      const text = "- Item 1\n  - Nested item\n    - Deeply nested\n";
      const result = MarkdownRenderer.renderChunk(text, 0);
      const lines = result.split("\n");
      expect(lines[0]).toBe(`  ${chalk.yellow("-")} Item 1`);
      expect(lines[1]).toBe(`    ${chalk.yellow("-")} Nested item`);
      expect(lines[2]).toBe(`      ${chalk.yellow("-")} Deeply nested`);
    });

    it("should render nested ordered lists correctly", () => {
      const text = "1. Item 1\n  2. Nested item\n    3. Deeply nested\n";
      const result = MarkdownRenderer.renderChunk(text, 0);
      const lines = result.split("\n");
      expect(lines[0]).toBe(`  ${chalk.yellow("1.")} Item 1`);
      expect(lines[1]).toBe(`    ${chalk.yellow("2.")} Nested item`);
      expect(lines[2]).toBe(`      ${chalk.yellow("3.")} Deeply nested`);
    });

    it("should render mixed nested lists correctly", () => {
      const text = "- Item 1\n  1. Nested ordered\n    - Deeply nested unordered\n";
      const result = MarkdownRenderer.renderChunk(text, 0);
      const lines = result.split("\n");
      expect(lines[0]).toBe(`  ${chalk.yellow("-")} Item 1`);
      expect(lines[1]).toBe(`    ${chalk.yellow("1.")} Nested ordered`);
      expect(lines[2]).toBe(`      ${chalk.yellow("-")} Deeply nested unordered`);
    });
  });

  describe("Effect-based methods", () => {
    it("should initialize with Effect", () => {
      const result = Effect.runSync(MarkdownRenderer.initialize());
      expect(result).toBeUndefined(); // Effect.void returns undefined
    });

    it("should render markdown with Effect", () => {
      const markdown = "## Header\n**Bold** text";
      const result = Effect.runSync(MarkdownRenderer.render(markdown));
      expect(result).toContain("Header");
      expect(result).toContain("Bold");
    });

    it("should handle render errors gracefully", () => {
      // render() should never throw, it falls back to plain text
      const invalidMarkdown = "Some text";
      const result = Effect.runSync(MarkdownRenderer.render(invalidMarkdown));
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("flushBuffer", () => {
    it("should flush remaining buffer", () => {
      // Reset to ensure clean state
      MarkdownRenderer.resetStreamingBuffer();
      // Add partial text that should be buffered (header pattern)
      const result1 = MarkdownRenderer.renderChunk("##", 0);
      expect(result1).toBe(""); // Should buffer because it looks like a header

      // Add more to complete it, but don't add newline
      const result2 = MarkdownRenderer.renderChunk(" Header", 0);
      expect(result2).toBe(""); // Still buffering

      // Now flush should return the formatted header
      const result3 = MarkdownRenderer.flushBuffer();
      expect(result3).toBe(chalk.bold.blue.underline("Header"));
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
