import chalk from "chalk";
import { Effect } from "effect";
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";

/**
 * Markdown renderer utility for terminal output
 */
export class MarkdownRenderer {
  private static initialized: boolean = false;
  private static streamingBuffer: string = "";
  private static lastFlushTime: number = 0;
  private static isInCodeBlock: boolean = false;

  /**
   * Initialize the markdown renderer with terminal-friendly options
   */
  static initialize(): void {
    if (this.initialized) {
      return;
    }

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
          emoji: true,
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

      this.initialized = true;
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
    if (!this.initialized) {
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
    return chalk.cyan(`🤖  ${agentName} is ${message}`);
  }

  /**
   * Format completion message with styling
   */
  static formatCompletion(agentName: string): string {
    return chalk.green(`✅  ${agentName} completed successfully`);
  }

  /**
   * Format warning message with styling
   */
  static formatWarning(agentName: string, message: string): string {
    return chalk.yellow(`⚠️  ${agentName}: ${message}`);
  }

  /**
   * Format error message with styling
   */
  static formatError(message: string): string {
    return chalk.red(`❌  ${message}`);
  }

  /**
   * Format info message with styling
   */
  static formatInfo(message: string): string {
    return chalk.blue(`ℹ️  ${message}`);
  }

  /**
   * Format success message with styling
   */
  static formatSuccess(message: string): string {
    return chalk.green(`✅  ${message}`);
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

    // Strategy:
    // 1. Always process complete lines (up to last newline) immediately
    // 2. For the remaining partial line:
    //    - If it looks like a header, HOLD it until newline (or end of stream)
    //    - If it ends with a markdown marker, HOLD it
    //    - Otherwise, flush if word boundary or timeout

    let output = "";

    // Check for complete lines
    const lastNewlineIndex = this.streamingBuffer.lastIndexOf("\n");
    if (lastNewlineIndex !== -1) {
      const completeLines = this.streamingBuffer.substring(0, lastNewlineIndex + 1);
      const remainder = this.streamingBuffer.substring(lastNewlineIndex + 1);

      output += this.applyProgressiveFormatting(completeLines);
      this.streamingBuffer = remainder;
      this.lastFlushTime = now;
    }

    // Now handle the remainder (partial line)
    if (this.streamingBuffer.length === 0) {
      return output;
    }

    // 1. Header protection: If it starts with #, wait for newline
    // Matches: "# ", "## ", "  ### "
    const isPotentialHeader = /^\s*#{1,6}/.test(this.streamingBuffer);
    if (isPotentialHeader) {
      return output; // Hold buffer
    }

    // 2. Marker protection: Don't split bold/italic/code markers
    const endsWithMarker = /[`*_~]\s*$/.test(this.streamingBuffer);
    if (endsWithMarker) {
      return output; // Hold buffer
    }

    // 3. Flush conditions
    const shouldFlush =
      this.streamingBuffer.endsWith(" ") ||
      (now - this.lastFlushTime > bufferMs && this.streamingBuffer.length > 0);

    if (shouldFlush) {
      const toRender = this.streamingBuffer;
      this.streamingBuffer = "";
      this.lastFlushTime = now;
      output += this.applyProgressiveFormatting(toRender);
    }

    return output;
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

    let formatted = text;

    // Handle code blocks (stateful)
    // We need to process line by line to track code block state correctly
    if (formatted.includes("```")) {
      const lines = formatted.split("\n");
      const processedLines = lines.map((line) => {
        // Check for code block toggle
        if (line.trim().startsWith("```")) {
          this.isInCodeBlock = !this.isInCodeBlock;
          return chalk.yellow(line); // Color the fence itself
        }

        // If inside code block, color the whole line
        if (this.isInCodeBlock) {
          return chalk.cyan(line);
        }

        return line;
      });
      formatted = processedLines.join("\n");
    } else if (this.isInCodeBlock) {
      // If we are inside a code block and this chunk has no fences, color it all
      formatted = chalk.cyan(formatted);
      // Return early as we don't want other formatting inside code blocks
      return formatted;
    }

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

    // Handle headers (# Header) - Updated to support leading spaces
    formatted = formatted.replace(/^\s*###\s+(.+)$/gm, (_match, header) => {
      return chalk.bold.blue(header);
    });
    formatted = formatted.replace(/^\s*##\s+(.+)$/gm, (_match, header) => {
      return chalk.bold.blue.underline(header);
    });
    formatted = formatted.replace(/^\s*#\s+(.+)$/gm, (_match, header) => {
      return chalk.bold.blue.underline(header);
    });

    // Handle blockquotes (> text)
    formatted = formatted.replace(/^\s*>\s+(.+)$/gm, (_match, content) => {
      return chalk.gray(`│ ${content}`);
    });

    // Handle lists (- item, * item, 1. item)
    formatted = formatted.replace(/^\s*([-*+])\s+(.+)$/gm, (_match, bullet, content) => {
      return `  ${chalk.yellow(bullet)} ${content}`;
    });
    formatted = formatted.replace(/^\s*(\d+\.)\s+(.+)$/gm, (_match, number, content) => {
      return `  ${chalk.yellow(number)} ${content}`;
    });

    // Handle horizontal rules (--- or ***)
    formatted = formatted.replace(/^\s*([-*_]){3,}\s*$/gm, () => {
      return chalk.gray("────────────────────────────────────────");
    });

    // Handle links [text](url) - simplified for streaming
    formatted = formatted.replace(/\[([^\]]+)\]\([^)]+\)/g, (_match, text) => {
      return chalk.blue.underline(text);
    });

    // Simple table highlighting (lines with |)
    if (formatted.includes("|")) {
      formatted = formatted.replace(/^.*\|.*$/gm, (line) => {
        // Don't format if it looks like code or other constructs
        if (line.trim().startsWith("```") || line.trim().startsWith(">")) return line;
        return chalk.white(line);
      });
    }

    return formatted;
  }

  /**
   * Reset streaming buffer (useful for new streams)
   */
  static resetStreamingBuffer(): void {
    this.streamingBuffer = "";
    this.lastFlushTime = 0;
    this.isInCodeBlock = false;
  }
}
