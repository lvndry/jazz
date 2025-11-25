import chalk from "chalk";
import { Effect } from "effect";
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";

/**
 * Streaming state for progressive markdown formatting
 */
interface StreamingState {
  readonly isInCodeBlock: boolean;
}

/**
 * Result of progressive formatting
 */
interface FormattingResult {
  readonly formatted: string;
  readonly state: StreamingState;
}

/**
 * Get terminal width, with fallback to 80
 */
function getTerminalWidth(): number {
  try {
    return process.stdout.columns || 80;
  } catch {
    return 80;
  }
}

/**
 * Markdown renderer utility for terminal output
 */
export class MarkdownRenderer {
  private static initialized: boolean = false;
  private static streamingBuffer: string = "";
  private static lastFlushTime: number = 0;
  private static streamingState: StreamingState = { isInCodeBlock: false };

  /**
   * Initialize the markdown renderer with terminal-friendly options
   */
  static initialize(): Effect.Effect<void, never> {
    if (this.initialized) {
      return Effect.void;
    }

    return Effect.sync(() => {
      try {
        const terminalWidth = getTerminalWidth();
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
            // Dynamic width based on terminal size
            width: terminalWidth,
          }) as unknown as Parameters<typeof marked.setOptions>[0]["renderer"],
          gfm: true, // GitHub Flavored Markdown
          breaks: true, // Convert line breaks to <br>
        });

        this.initialized = true;
      } catch (error: unknown) {
        // Log error but don't throw - allow fallback to plain text
        const message = error instanceof Error ? error.message : String(error);
        console.error("Error initializing markdown renderer:", message);
      }
    });
  }

  /**
   * Render markdown content to terminal-friendly text
   */
  static render(markdown: string): Effect.Effect<string, never> {
    return Effect.gen(function* () {
      yield* MarkdownRenderer.initialize();

      try {
        // Use marked.parse for synchronous parsing
        const result = marked.parse(markdown) as string;
        return result;
      } catch (error) {
        // Fallback to plain text if markdown parsing fails
        const message = error instanceof Error ? error.message : String(error);
        console.warn("Markdown parsing failed, falling back to plain text:", message);
        return markdown;
      }
    });
  }

  /**
   * Render markdown content with error handling (synchronous version for backward compatibility)
   */
  static renderSync(markdown: string): string {
    if (!this.initialized) {
      Effect.runSync(this.initialize());
    }

    try {
      return marked.parse(markdown) as string;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Markdown parsing failed, falling back to plain text:", message);
      return markdown;
    }
  }

  /**
   * Render markdown content with error handling
   */
  static renderSafe(markdown: string): Effect.Effect<string, never> {
    return this.render(markdown);
  }

  /**
   * Format agent response with proper styling
   */
  static formatAgentResponse(agentName: string, content: string): string {
    const header = chalk.bold.blue(`🤖 ${agentName}:`);
    const renderedContent = this.renderSync(content);
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

      const result = this.formatText(completeLines, this.streamingState);
      output += result.formatted;
      this.streamingState = result.state;
      this.streamingBuffer = remainder;
      this.lastFlushTime = now;
    }

    // Now handle the remainder (partial line)
    if (this.streamingBuffer.length === 0) {
      return output;
    }

    // 1. Header protection: If it starts with #, wait for newline
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
      const result = this.formatText(toRender, this.streamingState);
      output += result.formatted;
      this.streamingState = result.state;
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

    const result = this.formatText(toRender, this.streamingState);
    this.streamingState = result.state;
    return result.formatted;
  }

  /**
   * Format text using progressive formatting for streaming chunks
   */
  private static formatText(text: string, state: StreamingState): FormattingResult {
    if (!text || text.trim().length === 0) {
      return { formatted: text, state };
    }

    return this.applyProgressiveFormatting(text, state);
  }

  /**
   * Apply progressive markdown formatting
   * Handles common markdown constructs that can be rendered incrementally
   */
  private static applyProgressiveFormatting(text: string, state: StreamingState): FormattingResult {
    if (!text || text.trim().length === 0) {
      return { formatted: text, state };
    }

    // Handle code blocks first (stateful)
    const codeBlockResult = this.formatCodeBlocks(text, state);
    let formatted = codeBlockResult.formatted;
    const currentState = codeBlockResult.state;

    // If we're inside a code block, don't apply other formatting
    if (currentState.isInCodeBlock && !text.includes("```")) {
      return { formatted: codeBlockResult.formatted, state: currentState };
    }

    // Apply formatting in order (order matters for overlapping patterns)
    formatted = this.formatEscapedText(formatted);
    formatted = this.formatStrikethrough(formatted);
    formatted = this.formatBold(formatted);
    formatted = this.formatItalic(formatted);
    formatted = this.formatInlineCode(formatted);
    formatted = this.formatHeaders(formatted);
    formatted = this.formatBlockquotes(formatted);
    formatted = this.formatTaskLists(formatted);
    formatted = this.formatLists(formatted);
    formatted = this.formatHorizontalRules(formatted);
    formatted = this.formatLinks(formatted);

    return { formatted, state: currentState };
  }

  /**
   * Format code blocks with state tracking
   */
  private static formatCodeBlocks(text: string, state: StreamingState): FormattingResult {
    let isInCodeBlock = state.isInCodeBlock;

    if (text.includes("```")) {
      const lines = text.split("\n");
      const processedLines = lines.map((line) => {
        if (line.trim().startsWith("```")) {
          isInCodeBlock = !isInCodeBlock;
          return chalk.yellow(line);
        }

        if (isInCodeBlock) {
          return chalk.cyan(line);
        }

        return line;
      });

      return {
        formatted: processedLines.join("\n"),
        state: { isInCodeBlock },
      };
    }

    if (isInCodeBlock) {
      return {
        formatted: chalk.cyan(text),
        state: { isInCodeBlock },
      };
    }

    return { formatted: text, state: { isInCodeBlock } };
  }

  /**
   * Handle escaped markdown characters (e.g., \*, \_, \`)
   */
  private static formatEscapedText(text: string): string {
    return text.replace(/\\([*_`\\[\]()#+\-.!])/g, "$1");
  }

  /**
   * Format strikethrough text (~~text~~)
   */
  private static formatStrikethrough(text: string): string {
    return text.replace(/~~([^~]+)~~/g, (_match, content) => {
      return chalk.strikethrough(content);
    });
  }

  /**
   * Format bold text (**text**)
   * Must come before italic formatting to handle ***bold italic*** correctly
   */
  private static formatBold(text: string): string {
    return text.replace(/\*\*([^*]+)\*\*/g, (_match, bold) => {
      return chalk.bold(bold);
    });
  }

  /**
   * Format italic text (*text* or _text_)
   * Compatible regex without lookbehind/lookahead for better compatibility
   */
  private static formatItalic(text: string): string {
    let formatted = text;

    // Handle *text* (single asterisk, not part of **)
    formatted = formatted.replace(/\*([^*\n]+?)\*/g, (match, italic: string, offset: number) => {
      const beforeChar = offset > 0 ? text.charAt(offset - 1) : "";
      const afterIndex = offset + match.length;
      const afterChar = afterIndex < text.length ? text.charAt(afterIndex) : "";

      if (beforeChar === "*" || afterChar === "*") {
        return match;
      }

      return chalk.italic(italic);
    });

    // Handle _text_ (underscore, not part of __)
    formatted = formatted.replace(/_([^_\n]+?)_/g, (match, italic, offset) => {
      const offsetNum = Number(offset);
      const beforeChar = offsetNum > 0 ? text.charAt(offsetNum - 1) : "";
      const afterIndex = offsetNum + match.length;
      const afterChar = afterIndex < text.length ? text.charAt(afterIndex) : "";

      if (beforeChar === "_" || afterChar === "_") {
        return match;
      }

      return chalk.italic(italic);
    });

    return formatted;
  }

  /**
   * Format inline code (`code`)
   */
  private static formatInlineCode(text: string): string {
    return text.replace(/`([^`\n]+)`/g, (_match, code) => {
      return chalk.cyan(code);
    });
  }

  /**
   * Format headers (# Header)
   */
  private static formatHeaders(text: string): string {
    let formatted = text;

    // H3 (###)
    formatted = formatted.replace(/^\s*###\s+(.+)$/gm, (_match, header) => {
      return chalk.bold.blue(header);
    });

    // H2 (##)
    formatted = formatted.replace(/^\s*##\s+(.+)$/gm, (_match, header) => {
      return chalk.bold.blue.underline(header);
    });

    // H1 (#)
    formatted = formatted.replace(/^\s*#\s+(.+)$/gm, (_match, header) => {
      return chalk.bold.blue.underline(header);
    });

    return formatted;
  }

  /**
   * Format blockquotes (> text)
   */
  private static formatBlockquotes(text: string): string {
    return text.replace(/^\s*>\s+(.+)$/gm, (_match, content) => {
      return chalk.gray(`│ ${content}`);
    });
  }

  /**
   * Format task lists (- [ ] and - [x])
   */
  private static formatTaskLists(text: string): string {
    // Task list items: - [ ] or - [x] or - [X]
    return text.replace(
      /^\s*-\s+\[([ xX])\]\s+(.+)$/gm,
      (_match, checked: string, content: string) => {
        const isChecked = checked.toLowerCase() === "x";
        const checkbox = isChecked ? chalk.green("✓") : chalk.gray("○");
        const indent = "  ";
        return `${indent}${checkbox} ${content}`;
      },
    );
  }

  /**
   * Format lists (- item, * item, 1. item) with nested list support
   */
  private static formatLists(text: string): string {
    const formatted = text;

    // Process lines to detect indentation levels
    const lines = formatted.split("\n");
    const processedLines = lines.map((line) => {
      // Skip if already processed as task list
      if (line.includes("✓") || line.includes("○")) {
        return line;
      }

      // Unordered lists (-, *, +) with nested support
      const unorderedMatch = line.match(/^(\s*)([-*+])\s+(.+)$/);
      if (
        unorderedMatch &&
        unorderedMatch[1] !== undefined &&
        unorderedMatch[2] !== undefined &&
        unorderedMatch[3] !== undefined
      ) {
        const indent = unorderedMatch[1];
        const bullet = unorderedMatch[2];
        const content = unorderedMatch[3];
        const indentLevel = Math.floor(indent.length / 2); // Assume 2 spaces per level
        const indentStr = "  ".repeat(indentLevel + 1);
        return `${indentStr}${chalk.yellow(bullet)} ${content}`;
      }

      // Ordered lists (1., 2., etc.) with nested support
      const orderedMatch = line.match(/^(\s*)(\d+\.)\s+(.+)$/);
      if (
        orderedMatch &&
        orderedMatch[1] !== undefined &&
        orderedMatch[2] !== undefined &&
        orderedMatch[3] !== undefined
      ) {
        const indent = orderedMatch[1];
        const number = orderedMatch[2];
        const content = orderedMatch[3];
        const indentLevel = Math.floor(indent.length / 2);
        const indentStr = "  ".repeat(indentLevel + 1);
        return `${indentStr}${chalk.yellow(number)} ${content}`;
      }

      return line;
    });

    return processedLines.join("\n");
  }

  /**
   * Format horizontal rules (--- or ***)
   */
  private static formatHorizontalRules(text: string): string {
    const terminalWidth = getTerminalWidth();
    const ruleLength = Math.min(terminalWidth - 4, 40); // Max 40 chars, or terminal width - 4
    const rule = "─".repeat(ruleLength);
    return text.replace(/^\s*([-*_]){3,}\s*$/gm, () => {
      return chalk.gray(rule) + "\n";
    });
  }

  /**
   * Format links [text](url)
   */
  private static formatLinks(text: string): string {
    return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, _url) => {
      return chalk.blue.underline(text);
    });
  }

  /**
   * Reset streaming buffer (useful for new streams)
   */
  static resetStreamingBuffer(): void {
    this.streamingBuffer = "";
    this.lastFlushTime = 0;
    this.streamingState = { isInCodeBlock: false };
  }
}
