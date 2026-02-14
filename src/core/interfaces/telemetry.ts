import { Context, Effect } from "effect";
import type { TelemetryError } from "@/core/types/errors";

/**
 * Telemetry event types for categorizing recorded events.
 */
export type TelemetryEventType =
  | "agent_run_started"
  | "agent_run_completed"
  | "agent_run_failed"
  | "llm_request"
  | "llm_usage"
  | "llm_retry"
  | "tool_invocation"
  | "tool_error"
  | "command_executed"
  | "workflow_executed"
  | "workflow_scheduled"
  | "session_started"
  | "session_ended"
  | "custom";

/**
 * A single telemetry event recorded by the service.
 */
export interface TelemetryEvent {
  /** Unique event identifier */
  readonly id: string;
  /** Event type category */
  readonly type: TelemetryEventType;
  /** ISO 8601 timestamp of when the event occurred */
  readonly timestamp: string;
  /** Arbitrary structured data associated with the event */
  readonly data: Readonly<Record<string, unknown>>;
  /** Optional agent ID if the event is agent-scoped */
  readonly agentId?: string;
  /** Optional session/conversation ID */
  readonly sessionId?: string;
}

/**
 * Token usage snapshot from an LLM interaction.
 */
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** Estimated tokens consumed by tool definitions sent to the LLM. */
  readonly toolDefinitionTokens?: number;
  /** Estimated tokens consumed by tool results in the conversation context. */
  readonly toolResultTokens?: number;
  /** Number of tool definitions offered to the LLM. */
  readonly toolDefinitionsOffered?: number;
}

/**
 * Aggregated usage summary for a time period or agent run.
 */
export interface UsageSummary {
  /** Total number of LLM requests made */
  readonly totalRequests: number;
  /** Total tokens consumed (prompt + completion) */
  readonly totalTokens: number;
  /** Breakdown by token type */
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Estimated tokens consumed by tool definitions sent to the LLM */
  readonly toolDefinitionTokens: number;
  /** Estimated tokens consumed by tool results in the conversation context */
  readonly toolResultTokens: number;
  /** Total number of tool definitions offered to the LLM */
  readonly toolDefinitionsOffered: number;
  /** Total tool invocations */
  readonly totalToolCalls: number;
  /** Total tool errors encountered */
  readonly totalToolErrors: number;
  /** Total number of agent runs */
  readonly totalAgentRuns: number;
  /** Total duration of all tracked operations (ms) */
  readonly totalDurationMs: number;
  /** Per-model usage breakdown */
  readonly byModel: Readonly<Record<string, ModelUsage>>;
  /** Per-agent usage breakdown */
  readonly byAgent: Readonly<Record<string, AgentUsage>>;
}

/**
 * Usage breakdown for a specific model.
 */
export interface ModelUsage {
  readonly model: string;
  readonly provider: string;
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens: number;
}

/**
 * Usage breakdown for a specific agent.
 */
export interface AgentUsage {
  readonly agentId: string;
  readonly agentName: string;
  readonly runs: number;
  readonly totalTokens: number;
  readonly totalToolCalls: number;
  readonly totalDurationMs: number;
}

/**
 * Filter options for querying telemetry events.
 */
export interface TelemetryQueryOptions {
  /** Filter by event type(s) */
  readonly types?: readonly TelemetryEventType[];
  /** Filter by agent ID */
  readonly agentId?: string;
  /** Filter by session ID */
  readonly sessionId?: string;
  /** Start of time range (ISO 8601) */
  readonly from?: string;
  /** End of time range (ISO 8601) */
  readonly to?: string;
  /** Maximum number of events to return */
  readonly limit?: number;
  /** Offset for pagination */
  readonly offset?: number;
}

/**
 * Telemetry service interface for recording, querying, and summarizing
 * usage and telemetry data across agent runs, LLM calls, and tool invocations.
 *
 * All record* methods are fire-and-forget by design: they should never
 * block the caller or cause failures in the main application flow.
 */
export interface TelemetryService {
  // ── Recording ─────────────────────────────────────────────────────

  /**
   * Record an agent run starting.
   */
  readonly recordAgentRunStarted: (data: {
    readonly runId: string;
    readonly agentId: string;
    readonly agentName: string;
    readonly conversationId: string;
    readonly provider?: string;
    readonly model?: string;
  }) => Effect.Effect<void, TelemetryError>;

  /**
   * Record an agent run completing successfully.
   */
  readonly recordAgentRunCompleted: (data: {
    readonly runId: string;
    readonly agentId: string;
    readonly agentName: string;
    readonly conversationId: string;
    readonly provider?: string;
    readonly model?: string;
    readonly durationMs: number;
    readonly iterationsUsed: number;
    readonly finished: boolean;
    readonly usage: TokenUsage;
    readonly toolCalls: number;
    readonly toolErrors: number;
  }) => Effect.Effect<void, TelemetryError>;

  /**
   * Record an agent run failing.
   */
  readonly recordAgentRunFailed: (data: {
    readonly runId: string;
    readonly agentId: string;
    readonly agentName: string;
    readonly conversationId: string;
    readonly error: string;
    readonly durationMs: number;
  }) => Effect.Effect<void, TelemetryError>;

  /**
   * Record LLM token usage from a single request.
   */
  readonly recordLLMUsage: (data: {
    readonly provider: string;
    readonly model: string;
    readonly usage: TokenUsage;
    readonly agentId?: string;
    readonly sessionId?: string;
    readonly durationMs?: number;
  }) => Effect.Effect<void, TelemetryError>;

  /**
   * Record an LLM retry event.
   */
  readonly recordLLMRetry: (data: {
    readonly provider: string;
    readonly model: string;
    readonly error: string;
    readonly attempt: number;
    readonly agentId?: string;
  }) => Effect.Effect<void, TelemetryError>;

  /**
   * Record a tool invocation (success or failure).
   */
  readonly recordToolInvocation: (data: {
    readonly toolName: string;
    readonly success: boolean;
    readonly durationMs?: number;
    readonly error?: string;
    readonly agentId?: string;
    readonly sessionId?: string;
  }) => Effect.Effect<void, TelemetryError>;

  /**
   * Record a CLI command execution.
   */
  readonly recordCommandExecuted: (data: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly durationMs?: number;
    readonly success: boolean;
    readonly error?: string;
  }) => Effect.Effect<void, TelemetryError>;

  /**
   * Record a generic telemetry event.
   */
  readonly recordEvent: (
    type: TelemetryEventType,
    data: Record<string, unknown>,
    options?: {
      readonly agentId?: string;
      readonly sessionId?: string;
    },
  ) => Effect.Effect<void, TelemetryError>;

  // ── Querying ──────────────────────────────────────────────────────

  /**
   * Query recorded telemetry events with optional filters.
   */
  readonly getEvents: (
    options?: TelemetryQueryOptions,
  ) => Effect.Effect<readonly TelemetryEvent[], TelemetryError>;

  /**
   * Get an aggregated usage summary for the given time range.
   * If no range is specified, returns lifetime usage.
   */
  readonly getUsageSummary: (options?: {
    readonly from?: string;
    readonly to?: string;
    readonly agentId?: string;
  }) => Effect.Effect<UsageSummary, TelemetryError>;

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Flush any buffered events to persistent storage.
   * Called during graceful shutdown.
   */
  readonly flush: () => Effect.Effect<void, TelemetryError>;
}

export const TelemetryServiceTag = Context.GenericTag<TelemetryService>("TelemetryService");
