import { Effect } from "effect";
import type { StreamEvent } from "../../services/llm/streaming-types";
import { ToolCall } from "../../services/llm/tools";
import type { StreamingConfig } from "../types";
import { LLMError } from "../types/errors";
import { MarkdownRenderer } from "./markdown-renderer";
import type { ColorProfile, OutputMode, RenderTheme } from "./output-theme";
import { createTheme, detectColorProfile } from "./output-theme";
import type { OutputWriter } from "./output-writer";
import { JSONWriter, QuietWriter, TerminalWriter } from "./output-writer";
import { ThinkingRenderer } from "./thinking-renderer";
import {
  formatToolArguments as formatToolArgumentsShared,
  formatToolResult as formatToolResultShared,
} from "./tool-formatter";

/**
 * Display configuration for rendering
 * Simplified - removed format field since LLMs always output markdown
 */
export interface DisplayConfig {
  readonly showThinking: boolean;
  readonly showToolExecution: boolean;
  readonly mode: OutputMode;
  readonly colorProfile?: ColorProfile | undefined; // Auto-detect if not specified
}

/**
 * Output renderer configuration
 */
export interface OutputRendererConfig {
  readonly displayConfig: DisplayConfig;
  readonly streamingConfig: StreamingConfig;
  readonly showMetrics: boolean;
  readonly agentName: string;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high" | undefined;
}

/**
 * Output renderer for terminal display
 * Handles progressive rendering of streaming LLM responses
 * Supports multiple output modes: normal, quiet, verbose, json, accessible
 */
export class OutputRenderer {
  private readonly writer: OutputWriter;
  private readonly theme: RenderTheme;
  private readonly thinkingRenderer: ThinkingRenderer;
  private readonly toolNameMap: Map<string, string> = new Map();
  private readonly mode: OutputMode;

  constructor(private config: OutputRendererConfig) {
    // Determine color profile
    const colorProfile = config.displayConfig.colorProfile || detectColorProfile();

    // Determine output mode
    this.mode = config.displayConfig.mode;

    // Create appropriate writer based on mode
    this.writer = this.createWriter(this.mode);

    // Create theme (use no-color for json/accessible modes)
    this.theme = createTheme(
      this.mode === "json" || this.mode === "accessible" ? "none" : colorProfile,
    );

    // Create thinking renderer
    this.thinkingRenderer = new ThinkingRenderer(this.theme);
  }

  /**
   * Create writer based on output mode
   */
  private createWriter(mode: OutputMode): OutputWriter {
    switch (mode) {
      case "quiet":
        return new QuietWriter();
      case "json":
        return new JSONWriter();
      case "normal":
      case "verbose":
      case "accessible":
        return new TerminalWriter();
    }
  }

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
    // In quiet mode, only show errors
    if (this.mode === "quiet" && event.type !== "error") {
      return null;
    }

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
        // Tool call detected - execution will be handled by separate events
        if (this.mode === "verbose") {
          return this.renderToolCallVerbose(event.toolCall);
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
        if (this.mode === "verbose") {
          return this.renderUsageUpdate(event);
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
    // Always use markdown rendering since LLMs output markdown
    if (
      this.config.streamingConfig.progressiveMarkdown &&
      this.mode !== "json" &&
      this.mode !== "accessible"
    ) {
      // Use markdown renderer with buffering
      const bufferMs = this.config.streamingConfig.textBufferMs ?? 50;
      try {
        const rendered: string = MarkdownRenderer.renderChunk(delta, bufferMs);
        return rendered;
      } catch (error) {
        // Fallback to plain text if markdown rendering fails
        // Log warning in verbose mode
        if (this.mode === "verbose") {
          console.warn("Markdown rendering failed:", error);
        }
        return delta;
      }
    } else {
      // Plain text streaming for accessible/json modes
      return delta;
    }
  }

  private renderToolCallVerbose(toolCall: ToolCall): string {
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
    agentName: string;
  }): string {
    const { colors, icons } = this.theme;
    const tools = event.toolNames.join(", ");
    return (
      "\n" +
      colors.warning(`${icons.tool} ${event.agentName} is using tools: `) +
      colors.toolName(tools) +
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

    const argsStr = OutputRenderer.formatToolArguments(event.toolName, event.arguments);
    const { colors, icons } = this.theme;

    return (
      "\n" +
      colors.toolName(`${icons.tool}  Executing tool: `) +
      colors.toolName(event.toolName) +
      argsStr +
      "..."
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
    const summary = event.summary || OutputRenderer.formatToolResult(toolName, event.result);
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

  private renderUsageUpdate(event: {
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  }): string {
    const { colors } = this.theme;
    return (
      colors.dim(
        `\n[Tokens: ${event.usage.promptTokens} prompt + ${event.usage.completionTokens} completion = ${event.usage.totalTokens} total]\n`,
      ) + "\n"
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
      tokensPerSecond?: number;
      totalTokens?: number;
    };
  }): string {
    // Flush any remaining buffered markdown content
    if (
      this.config.streamingConfig.progressiveMarkdown &&
      this.mode !== "json" &&
      this.mode !== "accessible"
    ) {
      try {
        const remaining: string = MarkdownRenderer.flushBuffer();
        if (remaining.length > 0) {
          // Write immediately (side effect, but necessary for proper output)
          Effect.runSync(this.writer.write(remaining));
        }
      } catch {
        // Silently ignore flush errors
      }
    }

    let output = "";

    // Show metrics if enabled and available
    if (this.config.showMetrics && event.metrics) {
      const parts: string[] = [];

      if (event.metrics.firstTokenLatencyMs) {
        parts.push(`First token: ${event.metrics.firstTokenLatencyMs}ms`);
      }

      if (event.metrics.tokensPerSecond) {
        parts.push(`Speed: ${event.metrics.tokensPerSecond.toFixed(1)} tok/s`);
      }

      if (event.metrics.totalTokens) {
        parts.push(`Total: ${event.metrics.totalTokens} tokens`);
      }

      if (parts.length > 0) {
        output += this.theme.colors.dim(`\n[${parts.join(" | ")}]\n`);
      }
    }

    // In verbose mode, show total duration
    if (this.mode === "verbose") {
      output += this.theme.colors.dim(`\n[Total duration: ${event.totalDurationMs}ms]\n`);
    }

    // Add final newline for separation
    output += "\n";

    return output;
  }

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

  /**
   * Reset renderer state (call between conversations)
   */
  reset(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.toolNameMap.clear();
      this.thinkingRenderer.reset();
      MarkdownRenderer.resetStreamingBuffer();
    });
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

