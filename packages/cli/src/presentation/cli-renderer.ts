import { type LLMError } from "@jazz/core/types/errors";
import type { ColorProfile, DisplayConfig, OutputMode, RenderTheme } from "@jazz/core/types/output";
import type { StreamEvent, StreamingConfig } from "@jazz/core/types/streaming";
import type { ToolCall } from "@jazz/core/types/tools";
import { getModelsDevMetadataSync } from "@jazz/core/utils/models-dev";
import {
  compactToolArguments as compactToolArgumentsShared,
  formatToolArguments as formatToolArgumentsShared,
  formatToolDisplayName as formatToolDisplayNameShared,
  fileMutationDiffPreview,
  isDiffReceiptTool,
} from "@jazz/core/utils/tool-formatter";
import { computeUsageCostUSD } from "@jazz/core/utils/usage-cost";
import chalk from "chalk";
import { Effect } from "effect";
import { formatToolResult as formatToolResultShared } from "./format-utils";
import { createTheme, detectColorProfile } from "./output-theme";
import type { OutputWriter } from "./output-writer";
import { TerminalWriter } from "./output-writer";
import { ThinkingRenderer } from "./thinking-renderer";
import { getGlyphs } from "../ui/glyphs";
import { markdownToAnsi } from "../ui/markdown/ansi";
import {
  outputPreviewExpandKey,
  receiptDiffRows,
  receiptMark,
  receiptParts,
  toolReceipt,
} from "../ui/models/receipt";
import { formatCost, formatPreciseDuration } from "../ui/text/format";
import { paintRole, paintSegments } from "../ui/text/roles";
import { CHALK_THEME } from "../ui/theme";

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
 * Size threshold (in bytes) after which streaming formatting switches to
 * direct-append mode to avoid O(n²) re-formatting of the entire response.
 */
const STREAMING_FORMAT_SIZE_CAP = 8192;

/**
 * CLI renderer configuration
 */
export interface CLIRendererConfig {
  readonly displayConfig: DisplayConfig;
  readonly streamingConfig: StreamingConfig;
  readonly showMetrics: boolean;
  readonly agentName: string;
  readonly reasoning?: string | undefined;
}

/**
 * Default streaming configuration
 */
export const DEFAULT_STREAMING_CONFIG: StreamingConfig = {
  enabled: true,
  textBufferMs: 30,
};

/**
 * CLI renderer for terminal display — the NON-INK rendering path.
 *
 * ⚠️  There are TWO rendering paths for stream events:
 *
 * 1. **Ink path** (primary): `InkStreamingRenderer` in `ink-presentation-service.ts`
 *    uses the pure reducer (`activity-reducer.ts`) → pushes logs to the Ink `store`.
 *    This is the path used when the Ink UI is active (interactive CLI mode).
 *
 * 2. **Direct-write path** (this class): `CLIRenderer.handleEvent()` renders events
 *    to strings and writes them directly to stdout via `OutputWriter`.
 *    Used as a fallback when Ink is not available (non-interactive/piped output)
 *    and by `InkPresentationService` for one-off formatting (e.g. `formatToolExecutionStart`).
 *
 * When modifying tool call display, update BOTH paths:
 * - `activity-reducer.ts` (Ink path) — `tool_call` / `tool_execution_start` cases
 * - `CLIRenderer.renderEvent()` (this file) — corresponding render methods
 */
export class CLIRenderer {
  private readonly writer: OutputWriter;
  private readonly theme: RenderTheme;
  private readonly thinkingRenderer: ThinkingRenderer;
  /** Each running call's tool name and argument preview, for the receipt at completion. */
  private readonly toolNameMap: Map<string, { name: string; argsPreview: string }> = new Map();
  private readonly mode: OutputMode;
  private accumulatedUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
  } | null = null;
  private currentProvider: string | null = null;
  private currentModel: string | null = null;

  // Markdown rendering state (previously static in MarkdownRenderer)
  private streamingBuffer: string = "";
  private lastFlushTime: number = 0;
  private streamingRaw: string = "";
  private streamingFormatted: string = "";
  private streamingDirectAppend: boolean = false;

  constructor(private config: CLIRendererConfig) {
    // Determine output mode
    this.mode = config.displayConfig.mode ?? "hybrid";

    const isStyledMode = this.mode === "rendered" || this.mode === "hybrid";

    // Determine color profile
    const colorProfile: ColorProfile = isStyledMode
      ? config.displayConfig.colorProfile || detectColorProfile()
      : "none";

    // Create appropriate writer based on mode
    this.writer = this.createWriter(this.mode);

    // Create theme (disable colors for json/raw modes)
    this.theme = createTheme(colorProfile);

    // Create thinking renderer
    this.thinkingRenderer = new ThinkingRenderer(this.theme);
  }

  /**
   * Create writer based on output mode
   */
  private createWriter(mode: OutputMode): OutputWriter {
    switch (mode) {
      case "rendered":
      case "raw":
      case "hybrid":
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
        if (this.config.displayConfig.showReasoning) {
          return this.thinkingRenderer.handleStart();
        }
        return null;

      case "thinking_chunk":
        if (this.config.displayConfig.showReasoning && this.thinkingRenderer.isActive()) {
          return this.thinkingRenderer.handleChunk(event.content);
        }
        return null;

      case "thinking_complete":
        if (this.config.displayConfig.showReasoning) {
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
    // Track provider/model for cost calculation in renderComplete
    this.currentProvider = event.provider;
    this.currentModel = event.model;
    // Reset thinking state for new stream
    this.thinkingRenderer.reset();
    // Reset markdown streaming buffer for new stream
    this.resetStreamingBuffer();

    const reasoningInfo = this.config.reasoning
      ? this.theme.colors.dim(` [Reasoning: ${this.config.reasoning}]`)
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
    if (this.mode === "rendered") {
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
    metadata?: Record<string, unknown>;
  }): string {
    // Store tool name for later use in completion
    this.toolNameMap.set(event.toolCallId, {
      name: event.toolName,
      argsPreview: compactToolArgumentsShared(event.toolName, event.arguments),
    });

    const argsStr = formatToolArgumentsShared(event.toolName, event.arguments, {
      style: "colored",
      ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
    });
    const { colors, icons } = this.theme;

    return (
      "\n" +
      colors.toolName(`${icons.tool}  Executing tool: `) +
      colors.toolName(formatToolDisplayNameShared(event.toolName, event.metadata)) +
      argsStr
    );
  }

  private renderToolExecutionComplete(event: {
    toolCallId: string;
    toolName?: string;
    result: string;
    durationMs: number;
    summary?: string;
    success?: boolean;
    error?: string;
    classifiedRisk?: string;
  }): string {
    const started = this.toolNameMap.get(event.toolCallId);
    this.toolNameMap.delete(event.toolCallId);
    const toolName = started?.name ?? event.toolName;
    const receipt = toolReceipt({
      toolName,
      argsPreview: started?.argsPreview,
      success: event.success,
      error: event.error,
      summary: event.summary,
      result: event.result,
      durationMs: event.durationMs,
      classifiedRisk: event.classifiedRisk,
      diffPreview:
        toolName !== undefined && isDiffReceiptTool(toolName)
          ? fileMutationDiffPreview(event.result)
          : undefined,
    });
    const glyphs = getGlyphs();
    const mark = receiptMark(receipt, glyphs);
    const diffRows = receiptDiffRows(receipt)
      .map((row) => `\n   ${paintRole(row.role, row.text)}`)
      .join("");
    const outputPreview =
      receipt.outputPreview !== undefined && receipt.outputPreview.trim().length > 0
        ? `\n   ${chalk.dim(receipt.outputPreview)}${
            receipt.detail !== undefined && receipt.detail.trim() !== receipt.outputPreview.trim()
              ? chalk.dim(` · ${outputPreviewExpandKey(receipt.app)} to expand`)
              : ""
          }`
        : "";
    return ` ${paintRole(mark.role, mark.text)} ${paintSegments(receiptParts(receipt, glyphs, { duration: true }))}${outputPreview}${diffRows}\n\n`;
  }

  private renderError(error: LLMError): string {
    const { colors, icons } = this.theme;
    // Clean the error message to remove " | " separators and extra details
    let cleanMessage = error.message;
    if (cleanMessage.includes(" | ")) {
      cleanMessage = cleanMessage.split(" | ")[0] || cleanMessage;
    }
    // Also handle cases where message might have "|" without spaces
    if (cleanMessage.includes("|") && !cleanMessage.includes(" | ")) {
      const parts = cleanMessage.split("|");
      if (parts[0] && parts[0].trim().length > 0) {
        cleanMessage = parts[0].trim();
      }
    }
    return "\n" + colors.error(`${icons.error} Error: ${cleanMessage}`) + "\n";
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
    if (this.mode === "rendered") {
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

    // Show cost estimate if pricing data is available
    if (
      this.config.showMetrics &&
      this.accumulatedUsage &&
      this.currentModel &&
      this.currentProvider
    ) {
      const meta = getModelsDevMetadataSync(this.currentModel, this.currentProvider);
      if (meta?.inputPricePerMillion !== undefined || meta?.outputPricePerMillion !== undefined) {
        const outputPrice = meta.outputPricePerMillion ?? 0;
        const outputCost = (this.accumulatedUsage.completionTokens / 1_000_000) * outputPrice;
        const totalCost = computeUsageCostUSD(this.accumulatedUsage, meta) ?? 0;
        const inputCost = totalCost - outputCost;

        output += this.theme.colors.dim(
          `[Cost: ${formatCost(inputCost)} input + ${formatCost(outputCost)} output = ${formatCost(totalCost)} total]\n`,
        );
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

  // ==================== Markdown Rendering ====================

  /**
   * Render markdown content to terminal-friendly text, through the shared parser fullscreen
   * and Ink also use (or pass through raw markdown when markdown mode is disabled). Not
   * pre-wrapped: this writes straight to the real terminal, which wraps a long line itself;
   * tables and code fences still size themselves to the terminal's own width.
   */
  renderMarkdown(markdown: string): Effect.Effect<string, never> {
    if (this.mode !== "rendered") {
      return Effect.succeed(markdown);
    }
    return Effect.sync(() =>
      markdownToAnsi(markdown, { width: getTerminalWidth(), syntax: "rendered", wrapProse: false }),
    );
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

      output += this.formatText(completeLines);
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
      output += this.formatText(toRender);
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

    return this.formatText(toRender);
  }

  /**
   * Format text using progressive formatting for streaming chunks
   */
  /**
   * Format text using progressive formatting for streaming chunks
   */
  private getFormattedDelta(previous: string, next: string): string {
    if (next.startsWith(previous)) {
      return next.slice(previous.length);
    }
    // Fallback for rare non-prefix transitions after reformatting.
    let commonPrefixLength = 0;
    const maxPrefixLength = Math.min(previous.length, next.length);
    while (
      commonPrefixLength < maxPrefixLength &&
      previous.charCodeAt(commonPrefixLength) === next.charCodeAt(commonPrefixLength)
    ) {
      commonPrefixLength += 1;
    }
    return next.slice(commonPrefixLength);
  }

  private formatText(text: string): string {
    this.streamingRaw += text;

    // Once we exceed the size cap, switch to direct-append mode to avoid O(n²)
    // re-formatting. Trade-off: markdown constructs spanning the boundary may
    // not render perfectly, but performance is preserved for long outputs.
    if (!this.streamingDirectAppend && this.streamingRaw.length > STREAMING_FORMAT_SIZE_CAP) {
      this.streamingDirectAppend = true;
    }

    if (this.streamingDirectAppend) {
      // Direct append: format only the new chunk independently
      const formatted = this.formatMarkdownForMode(text);
      this.streamingFormatted += formatted;
      return formatted;
    }

    // Normal mode: re-format entire content and diff
    const nextFormatted = this.formatMarkdownForMode(this.streamingRaw);
    const delta = this.getFormattedDelta(this.streamingFormatted, nextFormatted);
    this.streamingFormatted = nextFormatted;
    return delta;
  }

  /**
   * Markdown as this mode shows it, through the shared parser — not pre-wrapped, since this
   * writes straight to the real terminal, which wraps a long line itself.
   */
  private formatMarkdownForMode(text: string): string {
    if (this.mode !== "rendered" && this.mode !== "hybrid") {
      return text;
    }
    const formatted = markdownToAnsi(text, {
      width: getTerminalWidth(),
      syntax: this.mode,
      wrapProse: false,
    });
    // markdownToAnsi trims trailing whitespace, which is right for a one-shot document but
    // wrong here: `renderChunk` splits its input at a line boundary specifically so the next
    // chunk can pick up on its own line, and a stripped trailing "\n" would glue that next
    // chunk onto the end of this one on the real terminal.
    return text.endsWith("\n") && !formatted.endsWith("\n") ? `${formatted}\n` : formatted;
  }

  // ==================== Public Formatting Methods ====================

  /**
   * Format agent response with proper styling
   */
  formatAgentResponse(agentName: string, content: string): Effect.Effect<string, never> {
    return Effect.gen(this, function* () {
      const header = CHALK_THEME.primaryBold(`◉ ${agentName}:`);
      const renderedContent = yield* this.renderMarkdown(content);
      return `${header}\n${renderedContent}`;
    });
  }

  /**
   * Format tool execution start message
   */
  formatToolExecutionStart(toolName: string, argsStr: string): Effect.Effect<string, never> {
    return Effect.sync(() => {
      return `\n${CHALK_THEME.primary(getGlyphs().arrow)} ${CHALK_THEME.primary(toolName)}${argsStr}`;
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
      const glyphs = getGlyphs();
      return ` ${CHALK_THEME.success(glyphs.success)}${summary ? ` ${summary}` : ""}${chalk.dim(` ${glyphs.bullet} ${formatPreciseDuration(durationMs)}`)}\n`;
    });
  }

  /**
   * Format tool execution error message
   */
  formatToolExecutionError(errorMessage: string, durationMs: number): Effect.Effect<string, never> {
    return Effect.sync(() => {
      const glyphs = getGlyphs();
      return ` ${CHALK_THEME.error(glyphs.error)} ${CHALK_THEME.error(errorMessage)}${chalk.dim(` ${glyphs.bullet} ${formatPreciseDuration(durationMs)}`)}\n`;
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
      return `\n${CHALK_THEME.primary("⌁")} ${CHALK_THEME.agentBold(agentName)} is using tools: ${CHALK_THEME.primary(formattedTools)}\n`;
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
      return CHALK_THEME.primary(`◉  ${agentName} is ${message}`);
    });
  }

  /**
   * Format completion message with styling
   */
  formatCompletion(agentName: string): Effect.Effect<string, never> {
    return Effect.sync(() => CHALK_THEME.success(`✔  ${agentName} completed successfully`));
  }

  /**
   * Format warning message with styling
   */
  formatWarning(agentName: string, message: string): Effect.Effect<string, never> {
    return Effect.sync(() => CHALK_THEME.warning(`⚠️  ${agentName}: ${message}`));
  }

  // ==================== Static Methods ====================

  /**
   * Format tool arguments for display (used in both streaming and non-streaming modes)
   */
  static formatToolArguments(
    toolName: string,
    args?: Record<string, unknown>,
    metadata?: Record<string, unknown>,
  ): string {
    return formatToolArgumentsShared(toolName, args, {
      style: "colored",
      ...(metadata !== undefined ? { metadata } : {}),
    });
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
    this.streamingRaw = "";
    this.streamingFormatted = "";
    this.streamingDirectAppend = false;
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
