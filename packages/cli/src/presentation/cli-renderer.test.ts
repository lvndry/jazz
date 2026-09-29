import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import chalk from "chalk";
import { Effect } from "effect";
import { CLIRenderer, type CLIRendererConfig } from "./cli-renderer";
import { codeColor, THEME } from "../ui/theme";

// The shared markdown parser's bullets, task marks and the horizontal rule read from the
// glyph set; force Unicode (jazz's default) rather than leaving this to the process's own
// terminal-capability detection. Restored in afterAll, unlike transcript.test.tsx's own
// beforeAll — a whole-suite run showed a later file's frame assertions are not robust to
// inheriting this setting, so it must not leak past this file's own tests.
const previousGlyphMode = process.env["JAZZ_UI_GLYPHS"];
beforeAll(() => {
  process.env["JAZZ_UI_GLYPHS"] = "unicode";
});
afterAll(() => {
  if (previousGlyphMode === undefined) {
    delete process.env["JAZZ_UI_GLYPHS"];
  } else {
    process.env["JAZZ_UI_GLYPHS"] = previousGlyphMode;
  }
});

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
      mode: "rendered",
      showReasoning: false,
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
  let previousChalkLevel: (typeof chalk)["level"];

  beforeEach(() => {
    // Every assertion in this file compares an exact plain string, so the chalk level must
    // be 0 for the run — the ambient default is NOT reliable: an earlier test file can leave
    // it raised (a known pitfall; see string-utils.test.ts's own note on this), and the shared
    // parser paints even a plain word if a role's colour differs from the terminal default.
    previousChalkLevel = chalk.level;
    chalk.level = 0;
    renderer = createTestRenderer();
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
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
      expect(result).toBe(chalk.bold.hex(THEME.selected)("Bold"));
    });

    it("should render italic text correctly", () => {
      const text = "*Italic*";
      renderer.testRenderChunk(text, 0);
      const result = renderer.testFlushBuffer();
      expect(result).toBe(chalk.italic.hex("#94A3B8")("Italic"));
    });

    it("should render inline code correctly", () => {
      const text = "`code`";
      renderer.testRenderChunk(text, 0);
      const result = renderer.testFlushBuffer();
      expect(result).toBe(codeColor("code"));
    });

    it("should render headers correctly", () => {
      // The shared parser (also used by fullscreen and Ink) renders a heading as bold
      // weight, not a coloured hue, and drops the "##" marker rather than styling it in
      // place — the same "no glyph, no hue" rule the fullscreen typography pass shipped.
      const text = "## Header\n";
      const result = renderer.testRenderChunk(text, 0);
      expect(result).toBe("Header\n");
    });

    it("should render blockquotes correctly", () => {
      const text = "> Quote\n";
      const result = renderer.testRenderChunk(text, 0);
      expect(result).toBe("▏ Quote\n");
    });

    it("should render unordered lists correctly", () => {
      // A bullet is normalised to the glyph set's own marker instead of keeping the
      // author's own "-"/"*"/"+" character, so every list reads the same regardless of
      // which one a model happened to write.
      const text = "- Item\n";
      const result = renderer.testRenderChunk(text, 0);
      expect(result).toBe("  ∙ Item\n");
    });

    it("should render ordered lists correctly", () => {
      const text = "1. Item\n";
      const result = renderer.testRenderChunk(text, 0);
      expect(result).toBe("  1. Item\n");
    });

    it("should render horizontal rules correctly", () => {
      // The rule runs to the terminal width (falls back to 80 columns off a real TTY),
      // capped at the prose measure.
      const text = "---\n";
      const result = renderer.testRenderChunk(text, 0);
      expect(result).toBe("─".repeat(80) + "\n");
    });

    it("should render code blocks when complete", () => {
      // Without real chalk colour (chalk.level 0 in this test process — see
      // string-utils.test.ts's own note on this) a fence keeps its ``` markers instead of
      // a painted band, same as the design's own "a band with no colour is only padding"
      // rule; assert on visible content rather than exact ANSI bytes.
      const chunk = "```typescript\nconst x = 1;\n```\n";
      const result = renderer.testRenderChunk(chunk, 0);
      expect(result).toBe("```typescript\nconst x = 1;\n```\n");

      // Content outside code block (plain)
      const chunk2 = "Plain text\n";
      const result2 = renderer.testRenderChunk(chunk2, 0);
      expect(result2).toBe("\nPlain text\n");
    });

    it("should handle code blocks split across chunks", () => {
      // When code blocks are split across chunks, content is streamed incrementally.
      // The delta-based approach outputs each chunk as it arrives.

      const chunk1 = "```typescript\n";
      const result1 = renderer.testRenderChunk(chunk1, 0);
      expect(result1).toContain("```typescript");

      const chunk2 = "const x = 1;\n";
      const result2 = renderer.testRenderChunk(chunk2, 0);
      expect(result2).toContain("const x = 1;");

      // The closing fence completes the block.
      // Note: When chalk colors are enabled, the formatter may re-emit the
      // entire colored block as the delta (since ANSI codes change the prefix).
      const chunk3 = "```\n";
      const result3 = renderer.testRenderChunk(chunk3, 0);
      expect(result3).toContain("```");
    });

    it("should properly reset code block state after closing fence", () => {
      // Start and end code block in same chunk
      const chunk1 = "```typescript\nconst x = 1;\n```\n";
      const result1 = renderer.testRenderChunk(chunk1, 0);
      expect(result1).toBe("```typescript\nconst x = 1;\n```\n");

      // Next chunk gets one blank line first — a fence is set off from what follows it,
      // same as heading and table blocks — then plain text, not still inside the fence.
      const chunk2 = "Normal text after code block\n";
      const result2 = renderer.testRenderChunk(chunk2, 0);
      expect(result2).toBe("\nNormal text after code block\n");
    });

    it("should handle multiple code blocks in sequence", () => {
      // First code block
      const chunk1 = "```typescript\nconst x = 1;\n```\n";
      renderer.testRenderChunk(chunk1, 0);

      // Second code block
      const chunk2 = "```python\nprint('hello')\n```\n";
      const result2 = renderer.testRenderChunk(chunk2, 0);
      expect(result2).toBe("\n```python\nprint('hello')\n```\n");

      // Text after should be plain, past the fence
      const chunk3 = "Normal text\n";
      const result3 = renderer.testRenderChunk(chunk3, 0);
      expect(result3).toBe("\nNormal text\n");
    });

    it("should buffer partial headers", () => {
      // Chunk 1: "##" (should be buffered)
      const chunk1 = "##";
      const result1 = renderer.testRenderChunk(chunk1, 0);
      expect(result1).toBe("");

      // Chunk 2: " Header\n" (should complete the header)
      const chunk2 = " Header\n";
      const result2 = renderer.testRenderChunk(chunk2, 0);
      expect(result2).toBe("Header\n");
    });

    it("should buffer partial headers with leading spaces", () => {
      // Chunk 1: "  ##" (should be buffered)
      const chunk1 = "  ##";
      const result1 = renderer.testRenderChunk(chunk1, 0);
      expect(result1).toBe("");

      // Chunk 2: " Header\n" (should complete the header)
      const chunk2 = " Header\n";
      const result2 = renderer.testRenderChunk(chunk2, 0);
      expect(result2).toBe("Header\n");
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
      expect(result3).toBe(chalk.bold.hex(THEME.selected)("Bold"));
    });

    it("should handle split headers across multiple chunks", () => {
      // Chunk 1: "##"
      expect(renderer.testRenderChunk("##", 0)).toBe("");
      // Chunk 2: " Hea"
      expect(renderer.testRenderChunk(" Hea", 0)).toBe("");
      // Chunk 3: "der\n"
      expect(renderer.testRenderChunk("der\n", 0)).toBe("Header\n");
    });

    it("should handle multiple lines correctly", () => {
      // Two lines with no blank line between them are one paragraph in CommonMark — a
      // soft break, which the shared parser joins with a space, the same as fullscreen.
      const text = "Line 1\nLine 2\n";
      const result = renderer.testRenderChunk(text, 0);
      expect(result).toBe("Line 1 Line 2\n");
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
      // A heading is set off by a blank line from what came before it.
      expect(result2).toBe("\nHeader\n");
    });

    it("should render strikethrough text correctly", () => {
      const text = "~~Strikethrough~~\n";
      const result = renderer.testRenderChunk(text, 0);
      expect(result).toBe("Strikethrough\n");
    });

    it("should render task lists correctly", () => {
      const text = "- [ ] Unchecked task\n- [x] Checked task\n- [X] Checked task uppercase\n";
      const result = renderer.testRenderChunk(text, 0);
      const lines = result.split("\n");
      expect(lines[0]).toBe("  ○ Unchecked task");
      expect(lines[1]).toBe("  ✓ Checked task");
      expect(lines[2]).toBe("  ✓ Checked task uppercase");
    });

    it("should render nested unordered lists correctly", () => {
      const text = "- Item 1\n  - Nested item\n    - Deeply nested\n";
      const result = renderer.testRenderChunk(text, 0);
      const lines = result.split("\n");
      expect(lines[0]).toBe("  ∙ Item 1");
      expect(lines[1]).toBe("    ∙ Nested item");
      expect(lines[2]).toBe("      ∙ Deeply nested");
    });

    it("should render nested ordered lists correctly", () => {
      const text = "1. Item 1\n  2. Nested item\n    3. Deeply nested\n";
      const result = renderer.testRenderChunk(text, 0);
      const lines = result.split("\n");
      expect(lines[0]).toBe(`  ${codeColor("1.")} Item 1`);
      expect(lines[1]).toBe(`    ${codeColor("2.")} Nested item`);
      expect(lines[2]).toBe(`      ${codeColor("3.")} Deeply nested`);
    });

    it("should render mixed nested lists correctly", () => {
      const text = "- Item 1\n  1. Nested ordered\n    - Deeply nested unordered\n";
      const result = renderer.testRenderChunk(text, 0);
      const lines = result.split("\n");
      expect(lines[0]).toBe("  ∙ Item 1");
      expect(lines[1]).toBe("    1. Nested ordered");
      expect(lines[2]).toBe("      ∙ Deeply nested unordered");
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
      expect(result3).toBe("Header");
    });

    it("should flush partial header as styled header if stream ends", () => {
      renderer.testRenderChunk("## Partial", 0); // buffers because it looks like header
      const result = renderer.testFlushBuffer();
      // If the stream ends, we process what we have.
      // Since "## Partial" matches the header regex (start of string), it gets styled.
      expect(result).toBe("Partial");
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
