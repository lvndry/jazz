/**
 * Core contracts for local telemetry events and optional OTLP export. Agent
 * runs use TelemetryTraceParent to retain one trace across recursive execution.
 */

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
  | "process_sample"
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
  /** Structured data emitted by the typed recording methods. */
  readonly data: Readonly<Record<string, unknown>>;
  /** Optional agent ID if the event is agent-scoped */
  readonly agentId?: string;
  /** Optional session/conversation ID */
  readonly conversationId?: string;
}

/**
 * The current agent run's trace identity, passed to a recursive agent run.
 * The child retains the top-level trace and session while nesting below this
 * run's span. Run identifiers are mapped to stable OTLP span ids at export.
 */
export interface TelemetryTraceParent {
  readonly topRunId: string;
  readonly parentRunId: string;
  readonly sessionId: string;
  /** A dispatch tool call wraps a recursive agent run when one exists. */
  readonly parentToolCallId?: string;
}

/** Bounded diagnostic categories that cannot contain provider or tool output. */
export type TelemetryErrorCategory =
  | "authentication"
  | "rate_limit"
  | "timeout"
  | "network"
  | "permission"
  | "not_found"
  | "validation"
  | "interrupted"
  | "provider"
  | "unknown";

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
 * Why this LLM request ran. Omitted on `llm_usage` means the agent loop
 * (system prompt, user input, tool results). Classifier calls are tagged
 * so a run's command-risk spend is not mistaken for the conversation.
 */
export type LLMCallPurpose = "classifier";

/**
 * Rolled-up command-risk classifier spend for one agent run.
 *
 * Kept beside, not inside, `usage`: `usage` is the agent-loop model
 * (system prompt + conversation), and mixing the cheap harness-model
 * classifier into those totals would hide both numbers.
 */
export interface ClassifierUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly requests: number;
  /** Wall-clock time spent in classifier LLM calls. */
  readonly durationMs: number;
}

/**
 * Rolled-up usage for bounded decision providers invoked by plugins.
 *
 * This deliberately contains only counters and spend. Requests, skill text,
 * provider responses, and plugin-authored diagnostics never enter telemetry.
 */
export interface DecisionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly requests: number;
  readonly durationMs: number;
  readonly costUSD: number;
  readonly costUnknown: boolean;
}

/**
 * Jazz process resources at one instant.
 *
 * RSS/heap/CPU are this process. GPU is omitted on purpose: Jazz does not
 * run the model. A local LLM's accelerator belongs to the model server.
 */
export interface ProcessResourceSnapshot {
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapTotalBytes: number;
  readonly externalBytes: number;
  /** Cumulative user-CPU milliseconds since process start. */
  readonly cpuUserMs: number;
  /** Cumulative system-CPU milliseconds since process start. */
  readonly cpuSystemMs: number;
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
  /** Command-risk classifier prompt tokens (subset of `promptTokens`) */
  readonly classifierPromptTokens: number;
  /** Command-risk classifier completion tokens (subset of `completionTokens`) */
  readonly classifierCompletionTokens: number;
  /** Command-risk classifier LLM requests (subset of `totalRequests`) */
  readonly classifierRequests: number;
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
  readonly conversationId?: string;
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
    readonly process?: ProcessResourceSnapshot;
    readonly telemetryParent?: TelemetryTraceParent;
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
    readonly classifierUsage?: ClassifierUsage;
    readonly decisionUsage?: DecisionUsage;
    readonly process?: ProcessResourceSnapshot;
    readonly toolCalls: number;
    readonly toolErrors: number;
    readonly telemetryParent?: TelemetryTraceParent;
  }) => Effect.Effect<void, TelemetryError>;

  /**
   * Record an agent run failing.
   */
  readonly recordAgentRunFailed: (data: {
    readonly runId: string;
    readonly agentId: string;
    readonly agentName: string;
    readonly conversationId: string;
    readonly error: TelemetryErrorCategory;
    readonly durationMs: number;
    readonly process?: ProcessResourceSnapshot;
    readonly telemetryParent?: TelemetryTraceParent;
  }) => Effect.Effect<void, TelemetryError>;

  /**
   * Record LLM token usage from a single request.
   */
  readonly recordLLMUsage: (data: {
    readonly provider: string;
    readonly model: string;
    readonly usage: TokenUsage;
    readonly agentId?: string;
    readonly conversationId?: string;
    readonly durationMs?: number;
    /** Groups this request under its agent run when exported as a trace. */
    readonly runId?: string;
    /** Distinguishes command-risk classifier calls from the agent loop. */
    readonly purpose?: LLMCallPurpose;
    readonly telemetryParent?: TelemetryTraceParent;
  }) => Effect.Effect<void, TelemetryError>;

  /**
   * Record an LLM retry event.
   */
  readonly recordLLMRetry: (data: {
    readonly provider: string;
    readonly model: string;
    readonly error: TelemetryErrorCategory;
    readonly attempt: number;
    readonly agentId?: string;
    readonly conversationId?: string;
    /** Groups this retry under its agent run when exported as a trace. */
    readonly runId?: string;
    readonly telemetryParent?: TelemetryTraceParent;
  }) => Effect.Effect<void, TelemetryError>;

  /**
   * Record a tool invocation (success or failure).
   */
  readonly recordToolInvocation: (data: {
    readonly toolName: string;
    readonly toolCallId?: string;
    readonly success: boolean;
    readonly durationMs?: number;
    readonly error?: TelemetryErrorCategory;
    readonly agentId?: string;
    readonly conversationId?: string;
    /** Groups this tool call under its agent run when exported as a trace. */
    readonly runId?: string;
    readonly telemetryParent?: TelemetryTraceParent;
  }) => Effect.Effect<void, TelemetryError>;

  /**
   * Record a CLI command execution.
   */
  readonly recordCommandExecuted: (data: {
    readonly command: string;
    readonly durationMs?: number;
    readonly success: boolean;
  }) => Effect.Effect<void, TelemetryError>;

  /**
   * Record a Jazz process resource sample (RSS, heap, CPU).
   * Emitted on a timer during a run, and as `process` on run start/end.
   */
  readonly recordProcessSample: (data: {
    readonly runId: string;
    readonly process: ProcessResourceSnapshot;
    readonly agentId?: string;
    readonly conversationId?: string;
  }) => Effect.Effect<void, TelemetryError>;

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

  /** Stop timers and drain pending export work during runtime shutdown. */
  readonly shutdown: () => Effect.Effect<void, TelemetryError>;
}

export const TelemetryServiceTag = Context.GenericTag<TelemetryService>("TelemetryService");
