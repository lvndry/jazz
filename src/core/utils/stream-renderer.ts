import chalk from "chalk";
import { Effect } from "effect";
import type { StreamEvent } from "../../services/llm/streaming-types";
import type { LLMError, ToolCall } from "../../services/llm/types";
import type { StreamingConfig } from "../types";
import { MarkdownRenderer } from "./markdown-renderer.js";

/**
 * Display configuration for rendering
 */
export interface DisplayConfig {
  readonly showThinking: boolean;
  readonly showToolExecution: boolean;
  readonly format: "plain" | "markdown";
}

/**
 * Stream renderer for terminal output
 * Handles progressive rendering of streaming LLM responses
 */
export class StreamRenderer {
  constructor(
    private displayConfig: DisplayConfig,
    private streamingConfig: StreamingConfig,
    private showMetrics: boolean,
    private agentName: string,
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
            this.renderThinkingStart();
          }
          break;

        case "thinking_chunk":
          if (this.displayConfig.showThinking) {
            this.renderThinkingChunk(event.content);
          }
          break;

        case "thinking_complete":
          if (this.displayConfig.showThinking) {
            this.renderThinkingComplete();
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
    console.log(`\n${chalk.bold.blue(this.agentName)} (${event.provider}/${event.model}):`);
  }

  private renderThinkingStart(): void {
    process.stdout.write(`\n${chalk.dim("🧠 Thinking...")}\n`);
  }

  private renderThinkingChunk(content: string): void {
    // Write thinking content in dimmed color
    process.stdout.write(chalk.dim(content));
  }

  private renderThinkingComplete(): void {
    process.stdout.write(chalk.dim(" ✓\n\n"));
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

  private renderToolExecutionStart(event: { toolName: string; toolCallId: string }): void {
    process.stdout.write(`\n${chalk.cyan("⚙️")}  Executing tool: ${chalk.cyan(event.toolName)}...`);
  }

  private renderToolExecutionComplete(event: { result: string; durationMs: number }): void {
    process.stdout.write(` ${chalk.green("✓")} ${chalk.dim(`(${event.durationMs}ms)`)}\n`);
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

    process.stdout.write(`\n\n`);

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
        process.stdout.write(chalk.dim(`[${parts.join(" | ")}]\n`));
      }
    }

    // Ensure stdout is flushed by writing a newline and using console.log for the final output
    // This ensures the prompt appears immediately after streaming completes
    // The newline from process.stdout.write("\n\n") above should trigger auto-flush,
    // but we add an extra newline to ensure clean separation
    process.stdout.write("\n");
  }
}

