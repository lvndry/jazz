import chalk from "chalk";
import { Effect } from "effect";
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";

/**
 * Markdown renderer utility for terminal output
 */
export class MarkdownRenderer {
  private static renderer: TerminalRenderer | null = null;
  private static streamingBuffer: string = "";
  private static lastFlushTime: number = 0;

  /**
   * Initialize the markdown renderer with terminal-friendly options
   */
  static initialize(): void {
    try {
      // Configure marked with our terminal renderer using setOptions
      // @ts-expect-error marked-terminal types are incompatible with marked v16
      // TerminalRenderer works at runtime but types don't match _Renderer interface
      marked.setOptions({
        renderer: new TerminalRenderer({
          // Color scheme for better readability
          code: chalk.cyan,
          codespan: chalk.cyan,
          blockquote: chalk.gray,
          html: chalk.gray,
          heading: chalk.bold.blue,
          firstHeading: chalk.bold.blue.underline,
          strong: chalk.bold.white,
          em: chalk.italic,
          del: chalk.strikethrough,
          link: chalk.blue.underline,
          href: chalk.gray,
          listitem: chalk.white,
          // Custom styling for better terminal experience
          paragraph: chalk.white,
          text: chalk.white,
          // Disable some features that don't work well in terminal
          showSectionPrefix: false,
          // Better spacing
          reflowText: true,
          // Maximum width for better readability
          width: 80,
        }) as unknown as Parameters<typeof marked.setOptions>[0]["renderer"],
        gfm: true, // GitHub Flavored Markdown
        breaks: true, // Convert line breaks to <br>
      });
    } catch (error: unknown) {
      console.error(
        "Error initializing markdown renderer:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Render markdown content to terminal-friendly text
   */
  static render(markdown: string): string {
    if (!this.renderer) {
      this.initialize();
    }

    try {
      // Use marked.parse for synchronous parsing
      return marked.parse(markdown) as string;
    } catch (error) {
      // Fallback to plain text if markdown parsing fails
      console.warn("Markdown parsing failed, falling back to plain text:", error);
      return markdown;
    }
  }

  /**
   * Render markdown content with error handling
   */
  static renderSafe(markdown: string): Effect.Effect<string, never> {
    return Effect.sync(() => this.render(markdown));
  }

  /**
   * Format agent response with proper styling
   */
  static formatAgentResponse(agentName: string, content: string): string {
    const header = chalk.bold.blue(`🤖 ${agentName}:`);
    const renderedContent = this.render(content);
    return `${header}\n${renderedContent}`;
  }

  /**
   * Format tool execution message with styling
   */
  static formatToolExecution(agentName: string, toolNames: string[]): string {
    const tools = toolNames.join(", ");
    return chalk.yellow(`🔧 ${agentName} is using tools: ${tools}`);
  }

  /**
   * Format thinking/processing message with styling
   */
  static formatThinking(agentName: string, isFirstIteration: boolean = false): string {
    const message = isFirstIteration ? "thinking..." : "processing results...";
    return chalk.cyan(`🤖 ${agentName} is ${message}`);
  }

  /**
   * Format completion message with styling
   */
  static formatCompletion(agentName: string): string {
    return chalk.green(`✅ ${agentName} completed successfully`);
  }

  /**
   * Format warning message with styling
   */
  static formatWarning(agentName: string, message: string): string {
    return chalk.yellow(`⚠️ ${agentName}: ${message}`);
  }

  /**
   * Format error message with styling
   */
  static formatError(message: string): string {
    return chalk.red(`❌ ${message}`);
  }

  /**
   * Format info message with styling
   */
  static formatInfo(message: string): string {
    return chalk.blue(`ℹ️ ${message}`);
  }

  /**
   * Format success message with styling
   */
  static formatSuccess(message: string): string {
    return chalk.green(`✅ ${message}`);
  }

  /**
   * Render markdown chunk progressively for streaming
   * Buffers incomplete syntax constructs and flushes on word boundaries
   *
   * @param delta - New text chunk to add
   * @param bufferMs - Buffer delay in milliseconds (default: 50ms)
   * @returns Rendered markdown string, or empty string if buffering
   */
  /**
   * Find the index where it is safe to flush the buffer
   * Ensures we don't flush incomplete markdown constructs
   */
  public static findSafeFlushIndex(text: string): number {
    let safeIndex = text.length;

    // 1. Code blocks (triple backticks ```...```)
    // Check for unclosed code blocks first (more specific than inline code)
    const codeBlockRegex = /```/g;
    const codeBlocks = text.match(codeBlockRegex);
    if (codeBlocks && codeBlocks.length % 2 !== 0) {
      const lastCodeBlock = text.lastIndexOf("```");
      if (lastCodeBlock !== -1) {
        safeIndex = Math.min(safeIndex, lastCodeBlock);
      }
    }

    // 2. Inline code blocks (single backticks `...`)
    // Only check if we're not inside a code block
    // Count single backticks that aren't part of triple backticks
    const singleBacktickRegex = /(?<!`)`(?!`)/g;
    const singleBackticks = text.match(singleBacktickRegex);
    if (singleBackticks && singleBackticks.length % 2 !== 0) {
      let lastIndex = -1;
      const regex = /(?<!`)`(?!`)/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        lastIndex = match.index;
      }
      if (lastIndex !== -1) {
        safeIndex = Math.min(safeIndex, lastIndex);
      }
    }

    // 3. Bold (**...**)
    const bolds = text.match(/\*\*/g);
    if (bolds && bolds.length % 2 !== 0) {
      const lastBold = text.lastIndexOf("**");
      if (lastBold !== -1) {
        safeIndex = Math.min(safeIndex, lastBold);
      }
    }

    // 4. Strikethrough (~~...~~)
    const strikethroughs = text.match(/~~/g);
    if (strikethroughs && strikethroughs.length % 2 !== 0) {
      const lastStrikethrough = text.lastIndexOf("~~");
      if (lastStrikethrough !== -1) {
        safeIndex = Math.min(safeIndex, lastStrikethrough);
      }
    }

    // 5. Italic (*...*)
    const italics = text.match(/(?<!\*)\*(?!\*)/g);
    if (italics && italics.length % 2 !== 0) {
      let lastIndex = -1;
      const regex = /(?<!\*)\*(?!\*)/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        lastIndex = match.index;
      }
      if (lastIndex !== -1) {
        safeIndex = Math.min(safeIndex, lastIndex);
      }
    }

    // 6. Italic (_..._)
    const underscores = text.match(/(?<!_)_(?!_)/g);
    if (underscores && underscores.length % 2 !== 0) {
      let lastIndex = -1;
      const regex = /(?<!_)_(?!_)/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        lastIndex = match.index;
      }
      if (lastIndex !== -1) {
        safeIndex = Math.min(safeIndex, lastIndex);
      }
    }

    // 7. Images (![...](...))
    const lastImageBracket = text.lastIndexOf("![");
    if (lastImageBracket !== -1) {
      const closingParen = text.indexOf(")", lastImageBracket);
      if (closingParen === -1) {
        safeIndex = Math.min(safeIndex, lastImageBracket);
      }
    }

    // 8. Links ([...](...))
    // Check for links that aren't images
    const lastOpenBracket = text.lastIndexOf("[");
    if (lastOpenBracket !== -1) {
      // Make sure it's not an image (no ! before [)
      const isImage = lastOpenBracket > 0 && text[lastOpenBracket - 1] === "!";
      if (!isImage) {
        const closingParen = text.indexOf(")", lastOpenBracket);
        if (closingParen === -1) {
          safeIndex = Math.min(safeIndex, lastOpenBracket);
        }
      }
    }

    // 9. Reference-style links ([text][ref])
    // Pattern: [text][ref] - check if we have [text][ but ref is incomplete
    // Find the last occurrence of ][ pattern that might be a reference link
    const refLinkPattern = /\[([^\]]+)\]\[([^\]]*)$/;
    const refLinkMatch = text.match(refLinkPattern);
    if (refLinkMatch) {
      // We have [text][ref where ref might be incomplete
      const matchIndex = refLinkMatch.index!;
      const refStart = matchIndex + refLinkMatch[1]!.length + 3; // Position after ][
      // If ref is empty or incomplete, don't flush past the opening [
      if (refLinkMatch[2]! === "" || !text.substring(refStart).includes("]")) {
        safeIndex = Math.min(safeIndex, matchIndex);
      }
    }

    // 10. Headings (#, ##, ###, etc.)
    // Headings are line-based: they start with 1-6 # characters followed by space
    // and end with a newline. If we have an incomplete heading (no newline), wait.
    // Check if the last line (if text doesn't end with newline) is a heading
    if (!text.endsWith("\n")) {
      const lastNewlineIndex = text.lastIndexOf("\n");
      const lastLineStart = lastNewlineIndex === -1 ? 0 : lastNewlineIndex + 1;
      const lastLine = text.substring(lastLineStart);

      // Heading pattern: starts with 1-6 # characters, followed by at least one space
      // Must be at start of line (or start of text)
      const headingPattern = /^#{1,6}\s+/;
      if (headingPattern.test(lastLine)) {
        // We have an incomplete heading - don't flush past the start of this line
        safeIndex = Math.min(safeIndex, lastLineStart);
      }

      // 11. Blockquotes (>)
      // Blockquotes are line-based: they start with > optionally followed by space
      // and end with a newline. If we have an incomplete blockquote (no newline), wait.
      // Blockquote pattern: starts with > optionally followed by space
      const blockquotePattern = /^>\s?/;
      if (blockquotePattern.test(lastLine)) {
        // We have an incomplete blockquote - don't flush past the start of this line
        safeIndex = Math.min(safeIndex, lastLineStart);
      }
    }

    return safeIndex;
  }

  /**
   * Render markdown chunk progressively for streaming
   * Buffers incomplete syntax constructs and flushes on word boundaries
   *
   * @param delta - New text chunk to add
   * @param bufferMs - Buffer delay in milliseconds (default: 50ms)
   * @returns Rendered markdown string, or empty string if buffering
   */
  static renderChunk(delta: string, bufferMs: number = 50): string {
    this.streamingBuffer += delta;
    const now = Date.now();

    // Check if we should flush based on word boundaries or time
    const shouldFlush =
      // Complete word (ends with space or newline)
      this.streamingBuffer.endsWith(" ") ||
      this.streamingBuffer.endsWith("\n") ||
      // Complete markdown construct (ends with closing markers)
      /[`*_~#)\]]\s*$/.test(this.streamingBuffer) ||
      // Time-based flush (prevent long delays)
      (now - this.lastFlushTime > bufferMs && this.streamingBuffer.length > 0);

    if (shouldFlush) {
      // Calculate safe flush index
      const safeIndex = this.findSafeFlushIndex(this.streamingBuffer);

      if (safeIndex > 0) {
        const toRender = this.streamingBuffer.substring(0, safeIndex);
        this.streamingBuffer = this.streamingBuffer.substring(safeIndex);
        this.lastFlushTime = now;

        // Apply basic markdown formatting for streaming
        return this.applyProgressiveFormatting(toRender);
      }
      // If safeIndex is 0, we can't flush anything yet, keep buffering
    }

    // Hold incomplete words/constructs
    return "";
  }

  /**
   * Flush any remaining buffered content
   * Call this when streaming is complete
   */
  static flushBuffer(): string {
    if (this.streamingBuffer.length === 0) {
      return "";
    }

    const toRender = this.streamingBuffer;
    this.streamingBuffer = "";
    this.lastFlushTime = Date.now();

    return this.applyProgressiveFormatting(toRender);
  }

  /**
   * Apply progressive markdown formatting
   * Handles common markdown constructs that can be rendered incrementally
   */
  private static applyProgressiveFormatting(text: string): string {
    if (!text || text.trim().length === 0) {
      return text;
    }

    // For streaming, we use a simpler approach than full markdown parsing
    // Full parsing would require complete markdown blocks which defeats streaming
    // Instead, we apply basic formatting for common patterns

    let formatted = text;

    // Handle inline code (backticks)
    formatted = formatted.replace(/`([^`]+)`/g, (_match, code) => {
      return chalk.cyan(code);
    });

    // Handle bold (**text**)
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, (_match, bold) => {
      return chalk.bold(bold);
    });

    // Handle italic (*text* or _text_)
    formatted = formatted.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_match, italic) => {
      return chalk.italic(italic);
    });
    formatted = formatted.replace(/(?<!_)_([^_]+)_(?!_)/g, (_match, italic) => {
      return chalk.italic(italic);
    });

    // Handle headers (# Header)
    formatted = formatted.replace(/^###\s+(.+)$/gm, (_match, header) => {
      return chalk.bold.blue(header);
    });
    formatted = formatted.replace(/^##\s+(.+)$/gm, (_match, header) => {
      return chalk.bold.blue.underline(header);
    });
    formatted = formatted.replace(/^#\s+(.+)$/gm, (_match, header) => {
      return chalk.bold.blue.underline(header);
    });

    // Handle links [text](url) - simplified for streaming
    formatted = formatted.replace(/\[([^\]]+)\]\([^)]+\)/g, (_match, text) => {
      return chalk.blue.underline(text);
    });

    // Note: For more complex markdown (lists, blockquotes, code blocks),
    // we'd need to buffer more content. For now, this handles the most common
    // streaming-friendly constructs.

    return formatted;
  }

  /**
   * Reset streaming buffer (useful for new streams)
   */
  static resetStreamingBuffer(): void {
    this.streamingBuffer = "";
    this.lastFlushTime = 0;
  }
}
