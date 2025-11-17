import chalk from "chalk";
import { Effect } from "effect";
import type { StreamEvent } from "../../services/llm/streaming-types";
import type { LLMError, ToolCall } from "../../services/llm/types";
import type { StreamingConfig } from "../types";
import { MarkdownRenderer } from "./markdown-renderer";
import {
  formatToolArguments as formatToolArgumentsShared,
  formatToolResult as formatToolResultShared,
} from "./tool-formatter";

/**
 * Display configuration for rendering
 */
export interface DisplayConfig {
  readonly showThinking: boolean;
  readonly showToolExecution: boolean;
  readonly format: "plain" | "markdown";
}

/**
 * Output renderer for terminal display
 * Handles progressive rendering of streaming LLM responses and provides
 * utility methods for formatting tool output in both streaming and non-streaming modes
 */
export class OutputRenderer {
  private toolNameMap: Map<string, string> = new Map();
  private thinkingStarted: boolean = false;
  private thinkingHasContent: boolean = false;

  constructor(
    private displayConfig: DisplayConfig,
    private streamingConfig: StreamingConfig,
    private showMetrics: boolean,
    private agentName: string,
    private reasoningEffort?: "disable" | "low" | "medium" | "high",
  ) {}

  /**
   * Handle a streaming event and update terminal
   */
  handleEvent(event: StreamEvent): Effect.Effect<void, never> {
    return Effect.sync(() => {
      switch (event.type) {
        case "stream_start":
          this.renderStreamStart(event);
          break;

        case "thinking_start":
          if (this.displayConfig.showThinking) {
            this.thinkingStarted = true;
            // Render header immediately when reasoning starts
            this.renderThinkingStart();
          }
          break;

        case "thinking_chunk":
          if (this.displayConfig.showThinking && this.thinkingStarted) {
            // Mark that we have content (even if this chunk is empty, we want to track that we're in a reasoning block)
            if (!this.thinkingHasContent) {
              this.thinkingHasContent = true;
            }
            // Always render chunks when reasoning is active
            this.renderThinkingChunk(event.content);
          }
          break;

        case "thinking_complete":
          if (this.displayConfig.showThinking) {
            // Show completion if reasoning was started (even if no chunks were received)
            // Always use renderThinkingComplete if we have token info, otherwise use minimal version
            if (this.thinkingStarted) {
              if (this.thinkingHasContent) {
                this.renderThinkingComplete(event);
                // Reset state after rendering
                this.thinkingStarted = false;
                this.thinkingHasContent = false;
              } else {
                // If header was shown but no content and no tokens, show minimal completion
                // Keep thinkingStarted true to allow token updates later
                process.stdout.write(`\n${chalk.dim("─".repeat(60))}\n${chalk.green("✓ Reasoning complete")}\n\n`);
                // Don't reset thinkingStarted yet - wait for potential token update
              }
            } else if (event.totalTokens !== undefined) {
              // This is an update with tokens after the initial completion
              // Rewrite the completion line with token info
              // Move cursor up to the separator line and rewrite both lines
              process.stdout.write(`\x1b[2A\x1b[0J`); // Move up 2 lines and clear to end of screen
              this.renderThinkingComplete(event);
              this.thinkingStarted = false;
              this.thinkingHasContent = false;
            }
          }
          break;

        case "text_start":
          this.renderTextStart();
          break;

        case "text_chunk":
          this.renderTextChunk(event.delta);
          break;

        case "tool_call":
          this.renderToolCall(event.toolCall);
          break;

        case "tools_detected":
          if (this.displayConfig.showToolExecution) {
            this.renderToolsDetected(event);
          }
          break;

        case "tool_execution_start":
          if (this.displayConfig.showToolExecution) {
            this.renderToolExecutionStart(event);
          }
          break;

        case "tool_execution_complete":
          if (this.displayConfig.showToolExecution) {
            this.renderToolExecutionComplete(event);
          }
          break;

        case "usage_update":
          // Optional: show token usage (can be enabled later)
          break;

        case "error":
          this.renderError(event.error);
          break;

        case "complete":
          this.renderComplete(event);
          break;
      }
    });
  }

  private renderStreamStart(event: { provider: string; model: string }): void {
    // Reset thinking state for new stream
    this.thinkingStarted = false;
    this.thinkingHasContent = false;
    const reasoningInfo = this.reasoningEffort
      ? chalk.dim(` [Reasoning: ${this.reasoningEffort}]`)
      : "";
    process.stdout.write(`\n${chalk.bold.blue(this.agentName)} (${event.provider}/${event.model})${reasoningInfo}:\n`);
  }

  private renderThinkingStart(): void {
    process.stdout.write(`\n${chalk.blue.bold("🧠 Agent Reasoning:")}\n${chalk.dim("─".repeat(60))}\n`);
  }

  private renderThinkingChunk(content: string): void {
    // Write thinking content in a readable format
    // Use blue color for better visibility while still distinguishing from main text
    process.stdout.write(chalk.italic.gray.dim(content));
  }

  private renderThinkingComplete(event?: { totalTokens?: number }): void {
    const totalTokens = event?.totalTokens;
    const tokenInfo = totalTokens ? chalk.dim(` (${totalTokens} reasoning tokens)`) : "";
    process.stdout.write(`\n${chalk.dim("─".repeat(60))}${tokenInfo}\n${chalk.green("✓ Reasoning complete")}\n\n`);
  }

  private renderTextStart(): void {
    // Start text section - no visual indicator needed
    // Text will start streaming immediately
  }

  private renderTextChunk(delta: string): void {
    if (this.streamingConfig.progressiveMarkdown && this.displayConfig.format === "markdown") {
      // Use markdown renderer to stream formatted output with buffering
      const bufferMs = this.streamingConfig.textBufferMs ?? 50;
      try {
        const rendered: string = MarkdownRenderer.renderChunk(delta, bufferMs);
        if (rendered.length > 0) {
          process.stdout.write(rendered);
        }
      } catch {
        // Fallback to plain text if markdown rendering fails
        process.stdout.write(delta);
      }
    } else {
      // Plain text streaming
      process.stdout.write(delta);
    }
  }

  private renderToolCall(_toolCall: ToolCall): void {
    // Note: Tool call detected, but don't execute yet
    // Agent runner will handle execution and emit tool_execution_start/complete events
    // We could show a subtle indicator here if needed
  }

  private renderToolsDetected(event: { toolNames: readonly string[]; agentName: string }): void {
    const tools = event.toolNames.join(", ");
    process.stdout.write(
      `\n${chalk.yellow("🔧")} ${chalk.yellow(event.agentName)} is using tools: ${chalk.cyan(tools)}\n`,
    );
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

  private renderToolExecutionStart(event: {
    toolName: string;
    toolCallId: string;
    arguments?: Record<string, unknown>;
  }): void {
    // Store tool name for later use in completion
    this.toolNameMap.set(event.toolCallId, event.toolName);

    const argsStr = OutputRenderer.formatToolArguments(event.toolName, event.arguments);
    process.stdout.write(
      `\n${chalk.cyan("⚙️")}  Executing tool: ${chalk.cyan(event.toolName)}${argsStr}...`,
    );
  }

  private renderToolExecutionComplete(event: {
    toolCallId: string;
    result: string;
    durationMs: number;
    summary?: string;
  }): void {
    // Get tool name from map
    const toolName = this.toolNameMap.get(event.toolCallId) || "";
    const summary = event.summary || OutputRenderer.formatToolResult(toolName, event.result);
    process.stdout.write(
      ` ${chalk.green("✓")}${summary ? ` ${summary}` : ""} ${chalk.dim(`(${event.durationMs}ms)`)}\n`,
    );

    // Clean up
    this.toolNameMap.delete(event.toolCallId);
  }

  private renderError(error: LLMError): void {
    console.error(`\n${chalk.red("✗")} Error: ${error.message}\n`);
  }

  private renderComplete(event: {
    totalDurationMs: number;
    metrics?: {
      firstTokenLatencyMs: number;
      tokensPerSecond?: number;
      totalTokens?: number;
    };
  }): void {
    // Flush any remaining buffered markdown content
    if (this.streamingConfig.progressiveMarkdown && this.displayConfig.format === "markdown") {
      try {
        const remaining: string = MarkdownRenderer.flushBuffer();
        if (remaining.length > 0) {
          process.stdout.write(remaining);
        }
      } catch {
        // Silently ignore flush errors
      }
    }

    // Show metrics at the end if enabled and available
    if (this.showMetrics && event.metrics) {
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
        process.stdout.write(chalk.dim(`\n[${parts.join(" | ")}]\n`));
      }
    }

    // Ensure stdout is flushed and add clear separation before the next prompt
    // Use console.log to ensure proper flushing and newline handling
    console.log();
  }
}
