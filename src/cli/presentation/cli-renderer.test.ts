import { beforeEach, describe, expect, it } from "bun:test";
import chalk from "chalk";
import { Effect } from "effect";
import { CLIRenderer, type CLIRendererConfig } from "./cli-renderer";
import { codeColor, CHALK_THEME } from "../ui/theme";

// Test helper class to access protected methods
class TestCLIRenderer extends CLIRenderer {
  // Expose protected methods for testing
  public testRenderChunk(delta: string, bufferMs: number = 50): string {
    return this.renderChunk(delta, bufferMs);
  }

  public testFlushBuffer(): string {
    return this.flushBuffer();
  }
}

// Helper to create a test renderer instance
function createTestRenderer(): TestCLIRenderer {
  const config: CLIRendererConfig = {
    displayConfig: {
      mode: "markdown",
      showThinking: false,
      showToolExecution: false,
    },
    streamingConfig: {},
    showMetrics: false,
    agentName: "TestAgent",
  };
  return new TestCLIRenderer(config);
}

describe("CLIRenderer", () => {
  let renderer: TestCLIRenderer;

  beforeEach(() => {
    renderer = createTestRenderer();
  });

  describe("renderChunk", () => {
    it("should render plain text correctly", () => {
      const text = "Hello world";
      // Access private method via type assertion for testing
      const result = renderer.testRenderChunk(text, 0);
      expect(result).toBe("Hello world");
    });

    it("should render bold text correctly", () => {
      const text = "**Bold**";
      renderer.testRenderChunk(text, 0);
      const result = renderer.testFlushBuffer();
      expect(result).toBe(chalk.bold("Bold"));
    });

    it("should render italic text correctly", () => {
      const text = "*Italic*";
      renderer.testRenderChunk(text, 0);
      const result = renderer.testFlushBuffer();
      expect(result).toBe(chalk.italic("Italic"));
    });

    it("should render inline code correctly", () => {
      const text = "`code`";
      renderer.testRenderChunk(text, 0);
      const result = renderer.testFlushBuffer();
      expect(result).toBe(codeColor("code"));
    });

    it("should render headers correctly", () => {
      const text = "## Header\n";
      const result = renderer.testRenderChunk(text, 0);
      expect(result).toBe(CHALK_THEME.headingUnderline("Header") + "\n");
    });

    it("should render blockquotes correctly", () => {
      const text = "> Quote\n";
      const result = renderer.testRenderChunk(text, 0);
      expect(result).toBe(chalk.gray("│ Quote") + "\n");
    });

    it("should render unordered lists correctly", () => {
      const text = "- Item\n";
      const result = renderer.testRenderChunk(text, 0);
      expect(result).toBe(`  ${chalk.yellow("-")} Item\n`);
    });

    it("should render ordered lists correctly", () => {
      const text = "1. Item\n";
      const result = renderer.testRenderChunk(text, 0);
      expect(result).toBe(`  ${chalk.yellow("1.")} Item\n`);
    });

    it("should render horizontal rules correctly", () => {
      const text = "---\n";
      const result = renderer.testRenderChunk(text, 0);
      // Horizontal rules now include a newline at the end
      expect(result).toBe(chalk.gray("────────────────────────────────────────") + "\n");
    });

    it("should render code blocks when complete", () => {
      // Code blocks are only colored when both opening and closing fences are present.
      // This allows inline markdown (bold, italic) to be properly formatted across chunks.

      // Start code block - not colored yet (incomplete)
      const chunk1 = "```typescript\n";
      const result1 = renderer.testRenderChunk(chunk1, 0);
      expect(result1).toBe("```typescript\n");

      // Content inside code block - still incomplete
      const chunk2 = "const x = 1;\n";
      const result2 = renderer.testRenderChunk(chunk2, 0);
      expect(result2).toBe("const x = 1;\n");

      // End code block - now the block is complete and the delta is the entire formatted block
      const chunk3 = "```\n";
      const result3 = renderer.testRenderChunk(chunk3, 0);
      // When the block completes, the reformatted delta includes the full colored block
      const expectedBlock =
        chalk.yellow("```typescript") +
        "\n" +
        codeColor("const x = 1;") +
        "\n" +
        chalk.yellow("```") +
        "\n";
      expect(result3).toBe(expectedBlock);

      // Content outside code block (plain)
      const chunk4 = "Plain text\n";
      const result4 = renderer.testRenderChunk(chunk4, 0);
      expect(result4).toBe("Plain text\n");
    });

    it("should properly reset code block state after closing fence", () => {
      // Start and end code block in same chunk
      const chunk1 = "```typescript\nconst x = 1;\n```\n";
      const result1 = renderer.testRenderChunk(chunk1, 0);
      const lines = result1.split("\n");
      expect(lines[0]).toBe(chalk.yellow("```typescript"));
      expect(lines[1]).toBe(codeColor("const x = 1;"));
      expect(lines[2]).toBe(chalk.yellow("```"));

      // Next chunk should be plain (not green)
      const chunk2 = "Normal text after code block\n";
      const result2 = renderer.testRenderChunk(chunk2, 0);
      expect(result2).toBe("Normal text after code block\n");
    });

    it("should handle multiple code blocks in sequence", () => {
      // First code block
      const chunk1 = "```typescript\nconst x = 1;\n```\n";
      renderer.testRenderChunk(chunk1, 0);

      // Second code block
      const chunk2 = "```python\nprint('hello')\n```\n";
      const result2 = renderer.testRenderChunk(chunk2, 0);
      const lines = result2.split("\n");
      expect(lines[0]).toBe(chalk.yellow("```python"));
      expect(lines[1]).toBe(codeColor("print('hello')"));
      expect(lines[2]).toBe(chalk.yellow("```"));

      // Text after should be plain
      const chunk3 = "Normal text\n";
      const result3 = renderer.testRenderChunk(chunk3, 0);
      expect(result3).toBe("Normal text\n");
    });

    it("should buffer partial headers", () => {
      // Chunk 1: "##" (should be buffered)
      const chunk1 = "##";
      const result1 = renderer.testRenderChunk(chunk1, 0);
      expect(result1).toBe("");

      // Chunk 2: " Header\n" (should complete the header)
      const chunk2 = " Header\n";
      const result2 = renderer.testRenderChunk(chunk2, 0);
      expect(result2).toBe(CHALK_THEME.headingUnderline("Header") + "\n");
    });

    it("should buffer partial headers with leading spaces", () => {
      // Chunk 1: "  ##" (should be buffered)
      const chunk1 = "  ##";
      const result1 = renderer.testRenderChunk(chunk1, 0);
      expect(result1).toBe("");

      // Chunk 2: " Header\n" (should complete the header)
      const chunk2 = " Header\n";
      const result2 = renderer.testRenderChunk(chunk2, 0);
      expect(result2).toBe(CHALK_THEME.headingUnderline("Header") + "\n");
    });

    it("should buffer partial bold markers", () => {
      // Chunk 1: "**" (should be buffered because it ends with marker)
      const chunk1 = "**";
      const result1 = renderer.testRenderChunk(chunk1, 0);
      expect(result1).toBe("");

      // Chunk 2: "Bold**" (should be buffered because it ends with marker)
      const chunk2 = "Bold**";
      const result2 = renderer.testRenderChunk(chunk2, 0);
      expect(result2).toBe("");

      // Flush buffer to get the result
      const result3 = renderer.testFlushBuffer();
      expect(result3).toBe(chalk.bold("Bold"));
    });

    it("should handle split headers across multiple chunks", () => {
      // Chunk 1: "##"
      expect(renderer.testRenderChunk("##", 0)).toBe("");
      // Chunk 2: " Hea"
      expect(renderer.testRenderChunk(" Hea", 0)).toBe("");
      // Chunk 3: "der\n"
      expect(renderer.testRenderChunk("der\n", 0)).toBe(
        CHALK_THEME.headingUnderline("Header") + "\n",
      );
    });

    it("should handle multiple lines correctly", () => {
      const text = "Line 1\nLine 2\n";
      const result = renderer.testRenderChunk(text, 0);
      expect(result).toBe("Line 1\nLine 2\n");
    });

    it("should handle mixed content with split header", () => {
      // Chunk 1: "Text\n##"
      const chunk1 = "Text\n##";
      const result1 = renderer.testRenderChunk(chunk1, 0);
      // Should return "Text\n" and buffer "##"
      expect(result1).toBe("Text\n");

      // Chunk 2: " Header\n"
      const chunk2 = " Header\n";
      const result2 = renderer.testRenderChunk(chunk2, 0);
      expect(result2).toBe(CHALK_THEME.headingUnderline("Header") + "\n");
    });

    it("should render strikethrough text correctly", () => {
      const text = "~~Strikethrough~~\n";
      const result = renderer.testRenderChunk(text, 0);
      expect(result).toBe(chalk.strikethrough("Strikethrough") + "\n");
    });

    it("should render task lists correctly", () => {
      const text = "- [ ] Unchecked task\n- [x] Checked task\n- [X] Checked task uppercase\n";
      const result = renderer.testRenderChunk(text, 0);
      const lines = result.split("\n");
      expect(lines[0]).toBe(`  ${chalk.gray("○")} Unchecked task`);
      expect(lines[1]).toBe(`  ${CHALK_THEME.success("✓")} Checked task`);
      expect(lines[2]).toBe(`  ${CHALK_THEME.success("✓")} Checked task uppercase`);
    });

    it("should render nested unordered lists correctly", () => {
      const text = "- Item 1\n  - Nested item\n    - Deeply nested\n";
      const result = renderer.testRenderChunk(text, 0);
      const lines = result.split("\n");
      expect(lines[0]).toBe(`  ${chalk.yellow("-")} Item 1`);
      expect(lines[1]).toBe(`    ${chalk.yellow("-")} Nested item`);
      expect(lines[2]).toBe(`      ${chalk.yellow("-")} Deeply nested`);
    });

    it("should render nested ordered lists correctly", () => {
      const text = "1. Item 1\n  2. Nested item\n    3. Deeply nested\n";
      const result = renderer.testRenderChunk(text, 0);
      const lines = result.split("\n");
      expect(lines[0]).toBe(`  ${chalk.yellow("1.")} Item 1`);
      expect(lines[1]).toBe(`    ${chalk.yellow("2.")} Nested item`);
      expect(lines[2]).toBe(`      ${chalk.yellow("3.")} Deeply nested`);
    });

    it("should render mixed nested lists correctly", () => {
      const text = "- Item 1\n  1. Nested ordered\n    - Deeply nested unordered\n";
      const result = renderer.testRenderChunk(text, 0);
      const lines = result.split("\n");
      expect(lines[0]).toBe(`  ${chalk.yellow("-")} Item 1`);
      expect(lines[1]).toBe(`    ${chalk.yellow("1.")} Nested ordered`);
      expect(lines[2]).toBe(`      ${chalk.yellow("-")} Deeply nested unordered`);
    });
  });

  describe("Effect-based methods", () => {
    it("should render markdown with Effect", () => {
      const markdown = "## Header\n**Bold** text";
      const result = Effect.runSync(renderer.renderMarkdown(markdown));
      expect(result).toContain("Header");
      expect(result).toContain("Bold");
    });

    it("should handle render errors gracefully", () => {
      // render() should never throw, it falls back to plain text
      const invalidMarkdown = "Some text";
      const result = Effect.runSync(renderer.renderMarkdown(invalidMarkdown));
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should format agent response", () => {
      const result = Effect.runSync(renderer.formatAgentResponse("TestAgent", "**Hello**"));
      expect(result).toContain("TestAgent");
      expect(result).toContain("Hello");
    });

    it("should format thinking message", () => {
      const result = Effect.runSync(renderer.formatThinking("TestAgent", true));
      expect(result).toContain("TestAgent");
      expect(result).toContain("thinking");
    });

    it("should format completion message", () => {
      const result = Effect.runSync(renderer.formatCompletion("TestAgent"));
      expect(result).toContain("TestAgent");
      expect(result).toContain("completed");
    });

    it("should format warning message", () => {
      const result = Effect.runSync(renderer.formatWarning("TestAgent", "Test warning"));
      expect(result).toContain("TestAgent");
      expect(result).toContain("Test warning");
    });
  });

  describe("flushBuffer", () => {
    it("should flush remaining buffer", () => {
      // Add partial text that should be buffered (header pattern)
      const result1 = renderer.testRenderChunk("##", 0);
      expect(result1).toBe(""); // Should buffer because it looks like a header

      // Add more to complete it, but don't add newline
      const result2 = renderer.testRenderChunk(" Header", 0);
      expect(result2).toBe(""); // Still buffering

      // Now flush should return the formatted header
      const result3 = renderer.testFlushBuffer();
      expect(result3).toBe(CHALK_THEME.headingUnderline("Header"));
    });

    it("should flush partial header as styled header if stream ends", () => {
      renderer.testRenderChunk("## Partial", 0); // buffers because it looks like header
      const result = renderer.testFlushBuffer();
      // If the stream ends, we process what we have.
      // Since "## Partial" matches the header regex (start of string), it gets styled.
      expect(result).toBe(CHALK_THEME.headingUnderline("Partial"));
    });
  });

  describe("Isolation tests", () => {
    it("should maintain separate state across different renderer instances", () => {
      const renderer1 = createTestRenderer();
      const renderer2 = createTestRenderer();

      // Start code block in renderer1
      (renderer1 as any).renderChunk("```typescript\n", 0);

      // renderer2 should not be affected
      const result = (renderer2 as any).renderChunk("Normal text\n", 0);
      expect(result).toBe("Normal text\n"); // Should not be colored (code color only inside blocks)
    });
  });
});
