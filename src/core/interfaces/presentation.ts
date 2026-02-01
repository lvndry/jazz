import { Context, Effect } from "effect";
import type { StreamEvent, StreamingConfig } from "@/core/types/streaming";
import type { ApprovalRequest, ApprovalOutcome } from "@/core/types/tools";
import type { DisplayConfig } from "../types";

/**
 * Presentation service interface for rendering agent output
 *
 * This interface abstracts presentation concerns from core business logic,
 * allowing different presentation implementations (CLI, web, API, etc.)
 * while keeping core logic independent of presentation details.
 */
export interface PresentationService {
  /**
   * Present a thinking/processing status to the user
   */
  readonly presentThinking: (
    agentName: string,
    isFirstIteration: boolean,
  ) => Effect.Effect<void, never>;

  /**
   * Present a completion status to the user
   */
  readonly presentCompletion: (agentName: string) => Effect.Effect<void, never>;

  /**
   * Present a warning to the user
   */
  readonly presentWarning: (agentName: string, message: string) => Effect.Effect<void, never>;

  /**
   * Present an agent response to the user
   */
  readonly presentAgentResponse: (agentName: string, content: string) => Effect.Effect<void, never>;

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
    toolsRequiringApproval: readonly string[],
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

  /**
   * Request user approval for a tool action.
   *
   * Shows a confirmation prompt with details about what action will be performed.
   * The user can approve (Yes) or reject (No). When rejecting, the user may optionally
   * provide a message to guide the agent (e.g. "Don't bump version; do X instead").
   *
   * This enables the Cursor/Claude-style approval flow where:
   * 1. A tool returns approvalRequired: true
   * 2. The system intercepts this and shows approval UI
   * 3. If approved, the system automatically calls the execution tool
   * 4. If rejected, the optional userMessage is passed to the LLM so it can adjust
   * 5. The combined result is returned to the LLM
   *
   * @param request - The approval request containing tool info and action details
   * @returns ApprovalOutcome: { approved: true } or { approved: false, userMessage?: string }
   */
  readonly requestApproval: (request: ApprovalRequest) => Effect.Effect<ApprovalOutcome, never>;
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
   * Register or clear a user interrupt handler for the active stream.
   */
  readonly setInterruptHandler: (
    handler: (() => void) | null,
  ) => Effect.Effect<void, never>;

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
