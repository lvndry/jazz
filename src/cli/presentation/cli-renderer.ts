import chalk from "chalk";
import { Effect } from "effect";
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";
import { type LLMError } from "../../core/types/errors";
import type { ColorProfile, DisplayConfig, OutputMode, RenderTheme } from "../../core/types/output";
import type { StreamEvent, StreamingConfig } from "../../core/types/streaming";
import type { ToolCall } from "../../core/types/tools";
import {
  formatToolArguments as formatToolArgumentsShared,
  formatToolResult as formatToolResultShared,
} from "../../core/utils/tool-formatter";
import { createTheme, detectColorProfile } from "./output-theme";
import type { OutputWriter } from "./output-writer";
import { JSONWriter, TerminalWriter } from "./output-writer";
import { ThinkingRenderer } from "./thinking-renderer";

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
 * CLI renderer configuration
 */
export interface CLIRendererConfig {
  readonly displayConfig: DisplayConfig;
  readonly streamingConfig: StreamingConfig;
  readonly showMetrics: boolean;
  readonly agentName: string;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high" | undefined;
}

/**
 * Default streaming configuration
 */
export const DEFAULT_STREAMING_CONFIG: StreamingConfig = {
  enabled: true,
  textBufferMs: 30,
};

/**
 * Unified CLI renderer for terminal display
 * Handles streaming events, markdown formatting, and progressive rendering
 */
export class CLIRenderer {
  private readonly writer: OutputWriter;
  private readonly theme: RenderTheme;
  private readonly thinkingRenderer: ThinkingRenderer;
  private readonly toolNameMap: Map<string, string> = new Map();
  private readonly mode: OutputMode;
  private accumulatedUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null = null;

  // Markdown rendering state (previously static in MarkdownRenderer)
  private markedInitialized: boolean = false;
  private streamingBuffer: string = "";
  private lastFlushTime: number = 0;
  private streamingState: StreamingState = { isInCodeBlock: false };

  constructor(private config: CLIRendererConfig) {
    // Determine output mode
    this.mode = config.displayConfig.mode ?? "markdown";

    const isMarkdownMode = this.mode === "markdown";

    // Determine color profile
    const colorProfile: ColorProfile = isMarkdownMode
      ? config.displayConfig.colorProfile || detectColorProfile()
      : "none";

    // Create appropriate writer based on mode
    this.writer = this.createWriter(this.mode);

    // Create theme (disable colors for json/raw modes)
    this.theme = createTheme(colorProfile);

    // Create thinking renderer
    this.thinkingRenderer = new ThinkingRenderer(this.theme);

    // Initialize markdown if in markdown mode
    if (isMarkdownMode) {
      Effect.runSync(this.initializeMarkdown());
    }
  }

  /**
   * Create writer based on output mode
   */
  private createWriter(mode: OutputMode): OutputWriter {
    switch (mode) {
      case "json":
        return new JSONWriter();
      case "markdown":
      case "raw":
      default:
        return new TerminalWriter();
    }
  }

  // ==================== Stream Event Handling ====================

  /**
   * Handle a streaming event and update output
   */
  handleEvent(event: StreamEvent): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const output = this.renderEvent(event);
      if (output) {
        yield* this.writer.write(output);
      }
    });
  }

  /**
   * Render an event to a string (pure function for easier testing)
   */
  private renderEvent(event: StreamEvent): string | null {
    switch (event.type) {
      case "stream_start":
        return this.renderStreamStart(event);

      case "thinking_start":
        if (this.config.displayConfig.showThinking) {
          return this.thinkingRenderer.handleStart();
        }
        return null;

      case "thinking_chunk":
        if (this.config.displayConfig.showThinking && this.thinkingRenderer.isActive()) {
          return this.thinkingRenderer.handleChunk(event.content);
        }
        return null;

      case "thinking_complete":
        if (this.config.displayConfig.showThinking) {
          const { output, shouldClearLines } = this.thinkingRenderer.handleComplete(
            event.totalTokens,
          );
          if (shouldClearLines > 0) {
            // Need to clear previous lines first
            Effect.runSync(this.writer.clearLines(shouldClearLines));
          }
          return output;
        }
        return null;

      case "text_start":
        // No visual indicator needed
        return null;

      case "text_chunk":
        return this.renderTextChunk(event.delta);

      case "tool_call":
        if (this.config.displayConfig.showToolExecution) {
          return this.renderToolCallDetected(event.toolCall);
        }
        return null;

      case "tools_detected":
        if (this.config.displayConfig.showToolExecution) {
          return this.renderToolsDetected(event);
        }
        return null;

      case "tool_execution_start":
        if (this.config.displayConfig.showToolExecution) {
          return this.renderToolExecutionStart(event);
        }
        return null;

      case "tool_execution_complete":
        if (this.config.displayConfig.showToolExecution) {
          return this.renderToolExecutionComplete(event);
        }
        return null;

      case "usage_update":
        if (this.config.showMetrics) {
          this.accumulatedUsage = event.usage;
        }
        return null;

      case "error": {
        const error = event.error;
        return this.renderError(error);
      }

      case "complete":
        return this.renderComplete(event);

      default:
        return null;
    }
  }

  private renderStreamStart(event: { provider: string; model: string }): string {
    // Reset thinking state for new stream
    this.thinkingRenderer.reset();
    // Reset markdown streaming buffer for new stream
    this.resetStreamingBuffer();

    const reasoningInfo = this.config.reasoningEffort
      ? this.theme.colors.dim(` [Reasoning: ${this.config.reasoningEffort}]`)
      : "";

    return (
      "\n" +
      this.theme.colors.agentName(this.config.agentName) +
      ` (${event.provider}/${event.model})` +
      reasoningInfo +
      ":\n"
    );
  }

  private renderTextChunk(delta: string): string {
    if (this.mode === "markdown") {
      const bufferMs =
        this.config.streamingConfig.textBufferMs ?? DEFAULT_STREAMING_CONFIG.textBufferMs;
      try {
        const rendered: string = this.renderChunk(delta, bufferMs);
        return rendered;
      } catch {
        // Fallback to plain text if markdown rendering fails
        return delta;
      }
    }

    // Plain text streaming for json/raw modes
    return delta;
  }

  private renderToolCallDetected(toolCall: ToolCall): string {
    const { colors, icons } = this.theme;
    return (
      "\n" +
      colors.dim(`${icons.tool} Tool call detected: `) +
      colors.toolName(toolCall.function.name) +
      "\n"
    );
  }

  private renderToolsDetected(event: {
    toolNames: readonly string[];
    toolsRequiringApproval: readonly string[];
    agentName: string;
  }): string {
    const { colors, icons } = this.theme;
    const approvalSet = new Set(event.toolsRequiringApproval);
    const formattedTools = event.toolNames
      .map((name) => {
        if (approvalSet.has(name)) {
          return `${name} ${colors.dim("(requires approval)")}`;
        }
        return name;
      })
      .join(", ");
    return (
      "\n" +
      colors.warning(`${icons.tool} ${event.agentName} is using tools: `) +
      colors.toolName(formattedTools) +
      "\n"
    );
  }

  private renderToolExecutionStart(event: {
    toolName: string;
    toolCallId: string;
    arguments?: Record<string, unknown>;
  }): string {
    // Store tool name for later use in completion
    this.toolNameMap.set(event.toolCallId, event.toolName);

    const argsStr = CLIRenderer.formatToolArguments(event.toolName, event.arguments);
    const { colors, icons } = this.theme;

    return (
      "\n" +
      colors.toolName(`${icons.tool}  Executing tool: `) +
      colors.toolName(event.toolName) +
      argsStr
    );
  }

  private renderToolExecutionComplete(event: {
    toolCallId: string;
    result: string;
    durationMs: number;
    summary?: string;
  }): string {
    // Get tool name from map
    const toolName = this.toolNameMap.get(event.toolCallId) || "";
    const summary = event.summary || CLIRenderer.formatToolResult(toolName, event.result);
    const { colors, icons } = this.theme;

    // Clean up
    this.toolNameMap.delete(event.toolCallId);

    return (
      ` ${colors.success(icons.success)}` +
      (summary ? ` ${summary}` : "") +
      ` ${colors.dim(`(${event.durationMs}ms)`)}` +
      "\n"
    );
  }

  private renderError(error: LLMError): string {
    const { colors, icons } = this.theme;
    return "\n" + colors.error(`${icons.error} Error: ${error.message}`) + "\n";
  }

  private renderComplete(event: {
    totalDurationMs: number;
    metrics?: {
      firstTokenLatencyMs: number;
      firstTextLatencyMs?: number;
      firstReasoningLatencyMs?: number;
      tokensPerSecond?: number;
      totalTokens?: number;
    };
  }): string {
    // Flush any remaining buffered markdown content
    if (this.mode === "markdown") {
      try {
        const remaining: string = this.flushBuffer();
        if (remaining.length > 0) {
          // Write immediately (side effect, but necessary for proper output)
          Effect.runSync(this.writer.write(remaining));
        }
      } catch {
        // Silently ignore flush errors
      }
    }

    let output = "";

    // Show accumulated usage if available
    if (this.config.showMetrics && this.accumulatedUsage) {
      output += this.theme.colors.dim(
        `\n\n[Tokens: ${this.accumulatedUsage.promptTokens} prompt + ${this.accumulatedUsage.completionTokens} completion = ${this.accumulatedUsage.totalTokens} total]\n`,
      );
    }

    // Show metrics if enabled and available
    if (this.config.showMetrics && event.metrics) {
      const parts: string[] = [];

      if (event.metrics.firstTokenLatencyMs) {
        parts.push(`First token: ${event.metrics.firstTokenLatencyMs}ms`);
      }

      if (event.metrics.firstReasoningLatencyMs) {
        parts.push(`Reasoning start: ${event.metrics.firstReasoningLatencyMs}ms`);
      }

      if (event.metrics.firstTextLatencyMs) {
        parts.push(`First text token: ${event.metrics.firstTextLatencyMs}ms`);
      }

      if (event.metrics.tokensPerSecond) {
        parts.push(`Speed: ${event.metrics.tokensPerSecond.toFixed(1)} tok/s`);
      }

      if (event.metrics.totalTokens) {
        parts.push(`Total: ${event.metrics.totalTokens} tokens`);
      }

      if (parts.length > 0) {
        output += this.theme.colors.dim(`[${parts.join(" | ")}]\n`);
      }
    }

    // Include total duration when metrics are enabled
    if (this.config.showMetrics) {
      output += this.theme.colors.dim(`[Total duration: ${event.totalDurationMs}ms]\n`);
    }

    // Add final newline for separation
    output += "\n";

    return output;
  }

  // ==================== Markdown Initialization ====================

  /**
   * Initialize the markdown renderer with terminal-friendly options
   */
  private initializeMarkdown(): Effect.Effect<void, never> {
    if (this.markedInitialized) {
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

        this.markedInitialized = true;
      } catch {
        // Log error but don't throw - allow fallback to plain text
        // Silently fall back - markdown initialization failure is not critical
      }
    });
  }

  // ==================== Markdown Rendering ====================

  /**
   * Render markdown content to terminal-friendly text
   */
  renderMarkdown(markdown: string): Effect.Effect<string, never> {
    return Effect.gen(this, function* () {
      yield* this.initializeMarkdown();

      try {
        // Use marked.parse for synchronous parsing
        const result = marked.parse(markdown) as string;
        return result;
      } catch {
        // Fallback to plain text if markdown parsing fails
        return markdown;
      }
    });
  }

  /**
   * Render markdown chunk progressively for streaming
   * Buffers incomplete syntax constructs and flushes on word boundaries
   * Protected for testing purposes
   */
  protected renderChunk(delta: string, bufferMs: number = 50): string {
    this.streamingBuffer += delta;
    const now = Date.now();

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
   * Protected for testing purposes
   */
  protected flushBuffer(): string {
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
  private formatText(text: string, state: StreamingState): FormattingResult {
    if (!text || text.trim().length === 0) {
      return { formatted: text, state };
    }

    return this.applyProgressiveFormatting(text, state);
  }

  /**
   * Apply progressive markdown formatting
   * Handles common markdown constructs that can be rendered incrementally
   */
  private applyProgressiveFormatting(text: string, state: StreamingState): FormattingResult {
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

  // ==================== Progressive Formatting Methods ====================

  private formatCodeBlocks(text: string, state: StreamingState): FormattingResult {
    let isInCodeBlock = state.isInCodeBlock;

    if (text.includes("```")) {
      const lines = text.split("\n");
      const processedLines: string[] = [];

      // Process lines sequentially to maintain correct state
      for (const line of lines) {
        if (line.trim().startsWith("```")) {
          // Toggle state when we see a code fence
          isInCodeBlock = !isInCodeBlock;
          processedLines.push(chalk.yellow(line));
        } else if (isInCodeBlock) {
          // If we're inside a code block, color the line cyan
          processedLines.push(chalk.cyan(line));
        } else {
          // Outside code block, leave as-is
          processedLines.push(line);
        }
      }

      return {
        formatted: processedLines.join("\n"),
        state: { isInCodeBlock },
      };
    }

    // If no code fences in this chunk, but we're in a code block, color everything cyan
    if (isInCodeBlock) {
      return {
        formatted: chalk.cyan(text),
        state: { isInCodeBlock },
      };
    }

    // Not in a code block, return as-is
    return { formatted: text, state: { isInCodeBlock } };
  }

  private formatEscapedText(text: string): string {
    return text.replace(/\\([*_`\\[\]()#+\-.!])/g, "$1");
  }

  private formatStrikethrough(text: string): string {
    return text.replace(/~~([^~]+)~~/g, (_match, content) => {
      return chalk.strikethrough(content);
    });
  }

  private formatBold(text: string): string {
    return text.replace(/\*\*([^*]+)\*\*/g, (_match, bold) => {
      return chalk.bold(bold);
    });
  }

  private formatItalic(text: string): string {
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

  private formatInlineCode(text: string): string {
    return text.replace(/`([^`\n]+)`/g, (_match, code) => {
      return chalk.cyan(code);
    });
  }

  private formatHeaders(text: string): string {
    let formatted = text;

    // H4 (####)
    formatted = formatted.replace(/^\s*####\s+(.+)$/gm, (_match, header) => {
      return chalk.bold(header);
    });

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

  private formatBlockquotes(text: string): string {
    return text.replace(/^\s*>\s+(.+)$/gm, (_match, content) => {
      return chalk.gray(`│ ${content}`);
    });
  }

  private formatTaskLists(text: string): string {
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

  private formatLists(text: string): string {
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

  private formatHorizontalRules(text: string): string {
    const terminalWidth = getTerminalWidth();
    const ruleLength = Math.min(terminalWidth - 4, 40); // Max 40 chars, or terminal width - 4
    const rule = "─".repeat(ruleLength);
    return text.replace(/^\s*([-*_]){3,}\s*$/gm, () => {
      return chalk.gray(rule) + "\n";
    });
  }

  private formatLinks(text: string): string {
    return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, _url) => {
      return chalk.blue.underline(text);
    });
  }

  // ==================== Public Formatting Methods ====================

  /**
   * Format agent response with proper styling
   */
  formatAgentResponse(agentName: string, content: string): Effect.Effect<string, never> {
    return Effect.gen(this, function* () {
      const header = chalk.bold.blue(`🤖 ${agentName}:`);
      const renderedContent = yield* this.renderMarkdown(content);
      return `${header}\n${renderedContent}`;
    });
  }

  /**
   * Format tool execution start message
   */
  formatToolExecutionStart(toolName: string, argsStr: string): Effect.Effect<string, never> {
    return Effect.sync(() => {
      return `\n${chalk.cyan("⚙️")}  Executing tool: ${chalk.cyan(toolName)}${argsStr}...`;
    });
  }

  /**
   * Format tool execution completion message
   */
  formatToolExecutionComplete(
    summary: string | null,
    durationMs: number,
  ): Effect.Effect<string, never> {
    return Effect.sync(() => {
      return ` ${chalk.green("✓")}${summary ? ` ${summary}` : ""} ${chalk.dim(`(${durationMs}ms)`)}\n`;
    });
  }

  /**
   * Format tool execution error message
   */
  formatToolExecutionError(errorMessage: string, durationMs: number): Effect.Effect<string, never> {
    return Effect.sync(() => {
      return ` ${chalk.red("✗")} ${chalk.red(`(${errorMessage})`)} ${chalk.dim(`(${durationMs}ms)`)}\n`;
    });
  }

  /**
   * Format tools detected message
   */
  formatToolsDetected(
    agentName: string,
    toolNames: readonly string[],
    toolsRequiringApproval: readonly string[],
  ): Effect.Effect<string, never> {
    return Effect.sync(() => {
      const approvalSet = new Set(toolsRequiringApproval);
      const formattedTools = toolNames
        .map((name) => {
          if (approvalSet.has(name)) {
            return `${name} ${chalk.dim("(requires approval)")}`;
          }
          return name;
        })
        .join(", ");
      return `\n${chalk.yellow("🔧")} ${chalk.yellow(agentName)} is using tools: ${chalk.cyan(formattedTools)}\n`;
    });
  }

  /**
   * Format thinking/processing message with styling
   */
  formatThinking(
    agentName: string,
    isFirstIteration: boolean = false,
  ): Effect.Effect<string, never> {
    return Effect.sync(() => {
      const message = isFirstIteration ? "thinking..." : "processing results...";
      return chalk.cyan(`🤖  ${agentName} is ${message}`);
    });
  }

  /**
   * Format completion message with styling
   */
  formatCompletion(agentName: string): Effect.Effect<string, never> {
    return Effect.sync(() => chalk.green(`✅  ${agentName} completed successfully`));
  }

  /**
   * Format warning message with styling
   */
  formatWarning(agentName: string, message: string): Effect.Effect<string, never> {
    return Effect.sync(() => chalk.yellow(`⚠️  ${agentName}: ${message}`));
  }

  // ==================== Static Methods ====================

  /**
   * Format tool arguments for display (used in both streaming and non-streaming modes)
   */
  static formatToolArguments(toolName: string, args?: Record<string, unknown>): string {
    return formatToolArgumentsShared(toolName, args, { style: "colored" });
  }

  /**
   * Format tool result for display (used in both streaming and non-streaming modes)
   */
  static formatToolResult(toolName: string, result: string): string {
    return formatToolResultShared(toolName, result);
  }

  // ==================== State Management ====================

  /**
   * Reset renderer state (call between conversations)
   */
  reset(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.toolNameMap.clear();
      this.thinkingRenderer.reset();
      this.accumulatedUsage = null;
      this.resetStreamingBuffer();
    });
  }

  /**
   * Reset streaming buffer (useful for new streams)
   */
  private resetStreamingBuffer(): void {
    this.streamingBuffer = "";
    this.lastFlushTime = 0;
    this.streamingState = { isInCodeBlock: false };
  }

  /**
   * Flush any pending output
   */
  flush(): Effect.Effect<void, never> {
    return this.writer.flush();
  }

  /**
   * Get the underlying writer (useful for testing)
   */
  getWriter(): OutputWriter {
    return this.writer;
  }
}

// Type export for backwards compatibility
export type { CLIRendererConfig as OutputRendererConfig };
