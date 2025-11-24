import { Context, Effect } from "effect";
import type { StreamEvent } from "../types/llm";
import type { DisplayConfig, StreamingConfig } from "../types/output";

/**
 * Presentation service interface for rendering agent output
 *
 * This interface abstracts presentation concerns from core business logic,
 * allowing different presentation implementations (CLI, web, API, etc.)
 * while keeping core logic independent of presentation details.
 */
export interface PresentationService {
  /**
   * Format a thinking/processing message
   */
  readonly formatThinking: (
    agentName: string,
    isFirstIteration: boolean,
  ) => Effect.Effect<string, never>;

  /**
   * Format a completion message
   */
  readonly formatCompletion: (agentName: string) => Effect.Effect<string, never>;

  /**
   * Format a warning message
   */
  readonly formatWarning: (agentName: string, message: string) => Effect.Effect<string, never>;

  /**
   * Format an agent response with proper styling
   */
  readonly formatAgentResponse: (
    agentName: string,
    content: string,
  ) => Effect.Effect<string, never>;

  /**
   * Render markdown content to formatted text
   */
  readonly renderMarkdown: (markdown: string) => Effect.Effect<string, never>;

  /**
   * Format tool arguments for display
   */
  readonly formatToolArguments: (toolName: string, args?: Record<string, unknown>) => string;

  /**
   * Format tool result for display
   */
  readonly formatToolResult: (toolName: string, result: string) => string;

  /**
   * Format tool execution start message
   */
  readonly formatToolExecutionStart: (
    toolName: string,
    args?: Record<string, unknown>,
  ) => Effect.Effect<string, never>;

  /**
   * Format tool execution complete message (success)
   */
  readonly formatToolExecutionComplete: (
    summary: string | null,
    durationMs: number,
  ) => Effect.Effect<string, never>;

  /**
   * Format tool execution error message
   */
  readonly formatToolExecutionError: (
    errorMessage: string,
    durationMs: number,
  ) => Effect.Effect<string, never>;

  /**
   * Format tools detected message
   */
  readonly formatToolsDetected: (
    agentName: string,
    toolNames: readonly string[],
  ) => Effect.Effect<string, never>;

  /**
   * Create a streaming renderer for real-time output
   */
  readonly createStreamingRenderer: (
    config: StreamingRendererConfig,
  ) => Effect.Effect<StreamingRenderer, never>;

  /**
   * Write output directly (for non-streaming mode)
   */
  readonly writeOutput: (message: string) => Effect.Effect<void, never>;

  /**
   * Write a blank line
   */
  readonly writeBlankLine: () => Effect.Effect<void, never>;
}

/**
 * Configuration for creating a streaming renderer
 */
export interface StreamingRendererConfig {
  readonly displayConfig: DisplayConfig;
  readonly streamingConfig: StreamingConfig;
  readonly showMetrics: boolean;
  readonly agentName: string;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high" | undefined;
}

/**
 * Streaming renderer interface for handling real-time stream events
 */
export interface StreamingRenderer {
  /**
   * Handle a streaming event
   */
  readonly handleEvent: (event: StreamEvent) => Effect.Effect<void, never>;

  /**
   * Reset renderer state (call between conversations)
   */
  readonly reset: () => Effect.Effect<void, never>;

  /**
   * Flush any pending output
   */
  readonly flush: () => Effect.Effect<void, never>;
}

/**
 * Service tag for dependency injection
 */
export const PresentationServiceTag =
  Context.GenericTag<PresentationService>("PresentationService");
