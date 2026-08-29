/**
 * Accumulates per-run metrics (iterations, tool calls, token usage, errors) into an
 * `AgentRunMetrics` record and emits them as telemetry events.
 */

import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { isZeroCostLocalModel } from "@/core/constants/local-providers";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { ClassifierUsage, TelemetryService, TokenUsage } from "@/core/interfaces/telemetry";
import { type Agent } from "@/core/types";
import type { ChatMessage } from "@/core/types/message";
import { emitTelemetry } from "@/core/utils/telemetry-emit";
import { computeUsageCostUSD, type UsageCostPricing } from "@/core/utils/usage-cost";
import { DEFAULT_TOKEN_COUNTER } from "../context/token-counter";

export interface AgentRunMetricsContext {
  readonly agent: Agent;
  readonly conversationId: string;
  readonly userId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high";
  readonly maxIterations?: number | undefined;
  /** Per-run spend ceiling in USD, for telemetry parity with `maxIterations`. Unset = uncapped. */
  readonly maxCostUSD?: number | undefined;
}

interface AgentRunIterationSummary {
  readonly iteration: number;
  toolCalls: number;
  readonly toolsUsed: Set<string>;
  readonly toolCallCounts: Record<string, number>;
  readonly errors: string[];
  readonly toolSequence: string[];
  toolDefinitionTokens: number;
  toolResultTokens: number;
  readonly toolResultSizes: Record<string, number>;
}

export interface AgentRunMetrics {
  readonly runId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly persona: string;
  readonly agentUpdatedAt: Date;
  readonly conversationId: string;
  readonly userId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high";
  readonly maxIterations: number | undefined;
  readonly maxCostUSD: number | undefined;
  readonly startedAt: Date;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalReasoningTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** Aggregated USD cost of nested runs (sub-agents) spawned during this run. */
  childCostUSD: number;
  /** True once any nested run spent tokens whose pricing was unavailable. */
  childCostUnknown: boolean;
  llmRetryCount: number;
  lastError?: string;
  toolCalls: number;
  toolErrors: number;
  readonly toolsUsed: Set<string>;
  readonly toolCallCounts: Record<string, number>;
  readonly toolInvocationSequence: string[];
  readonly errors: string[];
  readonly iterationSummaries: AgentRunIterationSummary[];
  currentIteration: AgentRunIterationSummary | undefined;
  firstTokenLatencyMs?: number | undefined;
  totalToolDefinitionTokens: number;
  totalToolResultTokens: number;
  toolDefinitionsOffered: number;
  /** Command-risk classifier prompt tokens. Not included in `totalPromptTokens`. */
  classifierPromptTokens: number;
  /** Command-risk classifier completion tokens. Not included in `totalCompletionTokens`. */
  classifierCompletionTokens: number;
  /** How many times the command-risk classifier ran during this run. */
  classifierRequests: number;
  /** Wall-clock time spent in classifier LLM calls. */
  classifierDurationMs: number;
}

export function createAgentRunMetrics(context: AgentRunMetricsContext): AgentRunMetrics {
  const {
    agent,
    conversationId,
    userId,
    provider,
    model,
    reasoningEffort,
    maxIterations,
    maxCostUSD,
  } = context;

  return {
    runId: randomUUID(),
    agentId: agent.id,
    agentName: agent.name,
    persona: agent.config.persona,
    agentUpdatedAt: agent.updatedAt,
    conversationId,
    ...(userId ? { userId } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    maxIterations,
    maxCostUSD,
    startedAt: new Date(),
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    childCostUSD: 0,
    childCostUnknown: false,
    llmRetryCount: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolsUsed: new Set<string>(),
    toolCallCounts: {},
    toolInvocationSequence: [],
    errors: [],
    iterationSummaries: [],
    currentIteration: undefined,
    firstTokenLatencyMs: undefined,
    totalToolDefinitionTokens: 0,
    totalToolResultTokens: 0,
    toolDefinitionsOffered: 0,
    classifierPromptTokens: 0,
    classifierCompletionTokens: 0,
    classifierRequests: 0,
    classifierDurationMs: 0,
  };
}

export function recordLLMUsage(
  metrics: AgentRunMetrics,
  usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly reasoningTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  },
): void {
  metrics.totalPromptTokens += usage.promptTokens;
  metrics.totalCompletionTokens += usage.completionTokens;
  if (usage.reasoningTokens != null) {
    metrics.totalReasoningTokens += usage.reasoningTokens;
  }
  if (usage.cacheReadTokens != null) {
    metrics.totalCacheReadTokens += usage.cacheReadTokens;
  }
  if (usage.cacheWriteTokens != null) {
    metrics.totalCacheWriteTokens += usage.cacheWriteTokens;
  }
}

export interface RunCost {
  /** Own-run cost plus any sub-agent cost. Undefined only when nothing is priced yet. */
  readonly costUSD: number | undefined;
  /**
   * True when some token spend in this run — the run's own turns or any sub-agent's —
   * lacked pricing metadata, so `costUSD` understates real spend. Cost-capped callers
   * must treat such runs as unpriced rather than let a cap silently under-enforce.
   */
  readonly costIncomplete: boolean;
}

/**
 * Price a run's accumulated usage, folding in any sub-agent spend recorded via
 * `childCostUSD`/`childCostUnknown`. Shared by run finalization (the reported
 * `AgentResponse.costUSD`) and the live cost-cap check in the agent loop, so the two
 * never compute cost differently.
 */
export function computeRunCost(
  metrics: Pick<
    AgentRunMetrics,
    | "totalPromptTokens"
    | "totalCompletionTokens"
    | "totalCacheReadTokens"
    | "childCostUSD"
    | "childCostUnknown"
    | "provider"
    | "model"
  >,
  pricing: UsageCostPricing | undefined,
): RunCost {
  const ownCostUSD =
    computeUsageCostUSD(
      {
        promptTokens: metrics.totalPromptTokens,
        completionTokens: metrics.totalCompletionTokens,
        cacheReadTokens: metrics.totalCacheReadTokens,
      },
      pricing,
    ) ?? undefined;

  // Report the run's own cost plus any sub-agent cost. Emit a figure whenever either
  // side is known — a run with unpriced parent tokens but priced sub-agents should
  // still surface the sub-agent spend.
  const costUSD =
    ownCostUSD !== undefined || metrics.childCostUSD > 0
      ? parseFloat(((ownCostUSD ?? 0) + metrics.childCostUSD).toFixed(8))
      : undefined;

  const ownCostUnknown =
    ownCostUSD === undefined &&
    metrics.totalPromptTokens + metrics.totalCompletionTokens > 0 &&
    !isZeroCostLocalModel(metrics.provider ?? "", metrics.model ?? "");

  return { costUSD, costIncomplete: ownCostUnknown || metrics.childCostUnknown };
}

/**
 * Record a command-risk classifier completion.
 *
 * Kept off the agent-loop totals: the classifier is a separate cheap-model
 * call, and mixing it in would hide how much of the run was conversation vs
 * approval gating.
 */
export function recordClassifierUsage(
  metrics: AgentRunMetrics,
  usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
  },
  durationMs: number,
): void {
  metrics.classifierPromptTokens += usage.promptTokens;
  metrics.classifierCompletionTokens += usage.completionTokens;
  metrics.classifierRequests += 1;
  metrics.classifierDurationMs += durationMs;
}

/**
 * Calibrate the default token counter using an authoritative usage report.
 *
 * Wires the model's actual `promptTokens` count into the per-model
 * chars-per-token ratio so subsequent pre-call estimates converge on truth.
 *
 * Safe to call from anywhere we receive `usage` from the AI SDK; a no-op
 * when inputs are missing or zero.
 */
export function calibrateTokenCounter(args: {
  readonly authoritativePromptTokens: number;
  readonly messagesAtCallTime: readonly ChatMessage[];
  readonly provider: string;
  readonly modelId: string;
}): void {
  DEFAULT_TOKEN_COUNTER.calibrate(args.authoritativePromptTokens, args.messagesAtCallTime, {
    provider: args.provider,
    modelId: args.modelId,
  });
}

export function recordLLMRetry(metrics: AgentRunMetrics, error: unknown): void {
  metrics.llmRetryCount += 1;
  metrics.lastError = pushError(metrics, error, "llm-retry");
}

export function beginIteration(metrics: AgentRunMetrics, iterationNumber: number): void {
  const summary: AgentRunIterationSummary = {
    iteration: iterationNumber,
    toolCalls: 0,
    toolsUsed: new Set<string>(),
    toolCallCounts: {},
    errors: [],
    toolSequence: [],
    toolDefinitionTokens: 0,
    toolResultTokens: 0,
    toolResultSizes: {},
  };
  metrics.currentIteration = summary;
  metrics.iterationSummaries.push(summary);
}

export function completeIteration(metrics: AgentRunMetrics): void {
  metrics.currentIteration = undefined;
}

export function recordToolInvocation(metrics: AgentRunMetrics, toolName: string): void {
  metrics.toolCalls += 1;
  metrics.toolsUsed.add(toolName);
  metrics.toolCallCounts[toolName] = (metrics.toolCallCounts[toolName] ?? 0) + 1;
  metrics.toolInvocationSequence.push(toolName);
  const current = metrics.currentIteration;

  if (current) {
    current.toolCalls += 1;
    current.toolsUsed.add(toolName);
    current.toolCallCounts[toolName] = (current.toolCallCounts[toolName] ?? 0) + 1;
    current.toolSequence.push(toolName);
  }
}

export function recordToolError(metrics: AgentRunMetrics, toolName: string, error: unknown): void {
  metrics.toolErrors += 1;
  metrics.lastError = pushError(metrics, error, `tool:${toolName}`);
}

/**
 * Estimate token count from a character count.
 * Uses the rough approximation of 1 token ≈ 4 characters for English text / JSON.
 */
export function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / 4);
}

/**
 * Record the token cost of tool definitions sent to the LLM for this iteration.
 */
export function recordToolDefinitionTokens(
  metrics: AgentRunMetrics,
  tokenEstimate: number,
  toolCount: number,
): void {
  metrics.totalToolDefinitionTokens += tokenEstimate;
  metrics.toolDefinitionsOffered += toolCount;
  if (metrics.currentIteration) {
    metrics.currentIteration.toolDefinitionTokens = tokenEstimate;
  }
}

/**
 * Record the token cost of a single tool result added to the conversation context.
 */
export function recordToolResultTokens(
  metrics: AgentRunMetrics,
  toolName: string,
  resultChars: number,
): void {
  const tokenEstimate = estimateTokens(resultChars);
  metrics.totalToolResultTokens += tokenEstimate;
  if (metrics.currentIteration) {
    metrics.currentIteration.toolResultTokens += tokenEstimate;
    metrics.currentIteration.toolResultSizes[toolName] =
      (metrics.currentIteration.toolResultSizes[toolName] ?? 0) + tokenEstimate;
  }
}

export function recordFirstTokenLatency(metrics: AgentRunMetrics, latencyMs: number): void {
  if (metrics.firstTokenLatencyMs === undefined) {
    metrics.firstTokenLatencyMs = latencyMs;
  }
}

export function recordLastError(metrics: AgentRunMetrics, error: unknown): void {
  metrics.lastError = pushError(metrics, error);
}

export function finalizeAgentRun(
  metrics: AgentRunMetrics,
  details: {
    readonly iterationsUsed: number;
    readonly finished: boolean;
    readonly costCapped?: boolean;
  },
): Effect.Effect<void, Error, LoggerService> {
  const endedAt = new Date();
  const durationMs = endedAt.getTime() - metrics.startedAt.getTime();
  const totalTokens = metrics.totalPromptTokens + metrics.totalCompletionTokens;
  const toolsUsedList = Array.from(metrics.toolsUsed.values()).sort();
  const sortedToolCallCounts: Record<string, number> = Object.fromEntries(
    Object.entries(metrics.toolCallCounts).sort(([a], [b]) => a.localeCompare(b)),
  );
  const sanitizedLastError =
    metrics.lastError && metrics.lastError.trim().length > 0 ? metrics.lastError : undefined;

  const iterationSummaries = metrics.iterationSummaries.map((summary) => ({
    iteration: summary.iteration,
    toolCalls: summary.toolCalls,
    toolsUsed: Array.from(summary.toolsUsed.values()).sort(),
    toolCallCounts: Object.fromEntries(
      Object.entries(summary.toolCallCounts).sort(([a], [b]) => a.localeCompare(b)),
    ),
    errors: summary.errors,
    toolSequence: summary.toolSequence,
    toolDefinitionTokens: summary.toolDefinitionTokens,
    toolResultTokens: summary.toolResultTokens,
    toolResultSizes: summary.toolResultSizes,
  }));

  return Effect.gen(function* () {
    // Write the standard token usage log
    yield* writeTokenUsageLog({
      runId: metrics.runId,
      agentId: metrics.agentId,
      agentName: metrics.agentName,
      persona: metrics.persona,
      agentUpdatedAt: metrics.agentUpdatedAt,
      conversationId: metrics.conversationId,
      ...(metrics.userId ? { userId: metrics.userId } : {}),
      ...(metrics.provider ? { provider: metrics.provider } : {}),
      ...(metrics.model ? { model: metrics.model } : {}),
      ...(metrics.reasoningEffort ? { reasoningEffort: metrics.reasoningEffort } : {}),
      promptTokens: metrics.totalPromptTokens,
      completionTokens: metrics.totalCompletionTokens,
      totalTokens,
      ...(metrics.totalReasoningTokens > 0 && { reasoningTokens: metrics.totalReasoningTokens }),
      ...(metrics.totalCacheReadTokens > 0 && { cacheReadTokens: metrics.totalCacheReadTokens }),
      ...(metrics.totalCacheWriteTokens > 0 && {
        cacheWriteTokens: metrics.totalCacheWriteTokens,
      }),
      iterations: details.iterationsUsed,
      maxIterations: metrics.maxIterations,
      ...(metrics.maxCostUSD !== undefined && { maxCostUSD: metrics.maxCostUSD }),
      finished: details.finished,
      ...(details.costCapped === true && { costCapped: true }),
      startedAt: metrics.startedAt,
      endedAt,
      durationMs,
      retryCount: metrics.llmRetryCount,
      ...(sanitizedLastError ? { lastError: sanitizedLastError } : {}),
      toolCalls: metrics.toolCalls,
      toolsUsed: toolsUsedList,
      toolErrors: metrics.toolErrors,
      toolCallCounts: sortedToolCallCounts,
      toolInvocationSequence: metrics.toolInvocationSequence,
      errors: metrics.errors,
      iterationSummaries,
      ...(metrics.firstTokenLatencyMs !== undefined
        ? { firstTokenLatencyMs: metrics.firstTokenLatencyMs }
        : {}),
      toolDefinitionTokens: metrics.totalToolDefinitionTokens,
      toolResultTokens: metrics.totalToolResultTokens,
      toolDefinitionsOffered: metrics.toolDefinitionsOffered,
      ...(metrics.classifierRequests > 0 && {
        classifierPromptTokens: metrics.classifierPromptTokens,
        classifierCompletionTokens: metrics.classifierCompletionTokens,
        classifierRequests: metrics.classifierRequests,
        classifierDurationMs: metrics.classifierDurationMs,
      }),
    });

    // Emit telemetry event (best-effort, never fails the run).
    // Uses Context.getOption to look up the service without adding TelemetryService to R.
    yield* emitAgentRunTelemetry(metrics, totalTokens, durationMs, details);
  });
}

interface TokenUsageLogPayload {
  readonly runId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly persona: string;
  readonly agentUpdatedAt: Date;
  readonly conversationId: string;
  readonly userId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high";
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly iterations: number;
  readonly maxIterations: number | undefined;
  readonly maxCostUSD?: number;
  readonly finished: boolean;
  readonly costCapped?: boolean;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly durationMs: number;
  readonly retryCount: number;
  readonly lastError?: string;
  readonly toolCalls: number;
  readonly toolsUsed: readonly string[];
  readonly toolErrors: number;
  readonly toolCallCounts: Readonly<Record<string, number>>;
  readonly toolInvocationSequence: readonly string[];
  readonly errors: readonly string[];
  readonly iterationSummaries: readonly {
    readonly iteration: number;
    readonly toolCalls: number;
    readonly toolsUsed: readonly string[];
    readonly toolCallCounts: Readonly<Record<string, number>>;
    readonly errors: readonly string[];
    readonly toolSequence: readonly string[];
    readonly toolDefinitionTokens: number;
    readonly toolResultTokens: number;
    readonly toolResultSizes: Readonly<Record<string, number>>;
  }[];
  readonly firstTokenLatencyMs?: number;
  readonly toolDefinitionTokens: number;
  readonly toolResultTokens: number;
  readonly toolDefinitionsOffered: number;
  readonly classifierPromptTokens?: number;
  readonly classifierCompletionTokens?: number;
  readonly classifierRequests?: number;
  readonly classifierDurationMs?: number;
}

function writeTokenUsageLog(
  payload: TokenUsageLogPayload,
): Effect.Effect<void, Error, LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;

    const logMeta = {
      runId: payload.runId,
      agentId: payload.agentId,
      agentName: payload.agentName,
      persona: payload.persona,
      agentUpdatedAt: payload.agentUpdatedAt.toISOString(),
      conversationId: payload.conversationId,
      userId: payload.userId ?? "anonymous",
      provider: payload.provider ?? "unknown",
      model: payload.model ?? "unknown",
      reasoningEffort: payload.reasoningEffort ?? "disable",
      iterations: payload.iterations,
      maxIterations: payload.maxIterations,
      ...(payload.maxCostUSD !== undefined && { maxCostUSD: payload.maxCostUSD }),
      finished: payload.finished,
      ...(payload.costCapped === true && { costCapped: true }),
      retryCount: payload.retryCount,
      ...(payload.lastError ? { lastError: payload.lastError } : {}),
      promptTokens: payload.promptTokens,
      completionTokens: payload.completionTokens,
      totalTokens: payload.totalTokens,
      ...(payload.reasoningTokens != null && { reasoningTokens: payload.reasoningTokens }),
      ...(payload.cacheReadTokens != null && { cacheReadTokens: payload.cacheReadTokens }),
      ...(payload.cacheWriteTokens != null && { cacheWriteTokens: payload.cacheWriteTokens }),
      ...(payload.firstTokenLatencyMs !== undefined
        ? { firstTokenLatencyMs: payload.firstTokenLatencyMs }
        : {}),
      toolCalls: payload.toolCalls,
      toolErrors: payload.toolErrors,
      toolsUsed: payload.toolsUsed,
      toolCallCounts: payload.toolCallCounts,
      toolInvocationSequence: payload.toolInvocationSequence,
      errors: payload.errors,
      iterationSummaries: payload.iterationSummaries,
      startedAt: payload.startedAt.toISOString(),
      endedAt: payload.endedAt.toISOString(),
      durationMs: payload.durationMs,
      toolDefinitionTokens: payload.toolDefinitionTokens,
      toolResultTokens: payload.toolResultTokens,
      toolDefinitionsOffered: payload.toolDefinitionsOffered,
      ...(payload.classifierRequests != null &&
        payload.classifierRequests > 0 && {
          classifierPromptTokens: payload.classifierPromptTokens,
          classifierCompletionTokens: payload.classifierCompletionTokens,
          classifierRequests: payload.classifierRequests,
          classifierDurationMs: payload.classifierDurationMs,
        }),
    };

    yield* logger.info("Agent token usage", logMeta);
  });
}

/** Payload type expected by TelemetryService.recordAgentRunCompleted */
type AgentRunCompletedPayload = Parameters<TelemetryService["recordAgentRunCompleted"]>[0];

/**
 * Build the telemetry data payload from agent run metrics.
 */
function buildTelemetryPayload(
  metrics: AgentRunMetrics,
  totalTokens: number,
  durationMs: number,
  details: { readonly iterationsUsed: number; readonly finished: boolean },
): AgentRunCompletedPayload {
  const usage: TokenUsage = {
    promptTokens: metrics.totalPromptTokens,
    completionTokens: metrics.totalCompletionTokens,
    totalTokens,
    ...(metrics.totalReasoningTokens > 0 && { reasoningTokens: metrics.totalReasoningTokens }),
    ...(metrics.totalCacheReadTokens > 0 && { cacheReadTokens: metrics.totalCacheReadTokens }),
    ...(metrics.totalCacheWriteTokens > 0 && {
      cacheWriteTokens: metrics.totalCacheWriteTokens,
    }),
    ...(metrics.totalToolDefinitionTokens > 0 && {
      toolDefinitionTokens: metrics.totalToolDefinitionTokens,
    }),
    ...(metrics.totalToolResultTokens > 0 && {
      toolResultTokens: metrics.totalToolResultTokens,
    }),
    ...(metrics.toolDefinitionsOffered > 0 && {
      toolDefinitionsOffered: metrics.toolDefinitionsOffered,
    }),
  };

  const classifierUsage: ClassifierUsage | undefined =
    metrics.classifierRequests > 0
      ? {
          promptTokens: metrics.classifierPromptTokens,
          completionTokens: metrics.classifierCompletionTokens,
          totalTokens: metrics.classifierPromptTokens + metrics.classifierCompletionTokens,
          requests: metrics.classifierRequests,
          durationMs: metrics.classifierDurationMs,
        }
      : undefined;

  return {
    runId: metrics.runId,
    agentId: metrics.agentId,
    agentName: metrics.agentName,
    conversationId: metrics.conversationId,
    ...(metrics.provider && { provider: metrics.provider }),
    ...(metrics.model && { model: metrics.model }),
    durationMs,
    iterationsUsed: details.iterationsUsed,
    finished: details.finished,
    usage,
    ...(classifierUsage && { classifierUsage }),
    toolCalls: metrics.toolCalls,
    toolErrors: metrics.toolErrors,
  };
}

function emitAgentRunTelemetry(
  metrics: AgentRunMetrics,
  totalTokens: number,
  durationMs: number,
  details: { readonly iterationsUsed: number; readonly finished: boolean },
): Effect.Effect<void> {
  const payload = buildTelemetryPayload(metrics, totalTokens, durationMs, details);
  return emitTelemetry((telemetry) => telemetry.recordAgentRunCompleted(payload));
}

/** Emit `agent_run_started` at the top of a run. Best-effort. */
export function emitAgentRunStarted(metrics: AgentRunMetrics): Effect.Effect<void> {
  return emitTelemetry((telemetry) =>
    telemetry.recordAgentRunStarted({
      runId: metrics.runId,
      agentId: metrics.agentId,
      agentName: metrics.agentName,
      conversationId: metrics.conversationId,
      ...(metrics.provider && { provider: metrics.provider }),
      ...(metrics.model && { model: metrics.model }),
    }),
  );
}

/**
 * Emit `agent_run_failed` when the run dies before `finalizeAgentRun` is
 * reached. A run emits either this or `agent_run_completed`, never both.
 */
export function emitAgentRunFailed(metrics: AgentRunMetrics, error: unknown): Effect.Effect<void> {
  const durationMs = Date.now() - metrics.startedAt.getTime();
  return emitTelemetry((telemetry) =>
    telemetry.recordAgentRunFailed({
      runId: metrics.runId,
      agentId: metrics.agentId,
      agentName: metrics.agentName,
      conversationId: metrics.conversationId,
      error: normalizeError(error),
      durationMs,
    }),
  );
}

/** Emit `llm_usage` for a single completion. Best-effort. */
export function emitLLMUsage(
  metrics: AgentRunMetrics,
  usage: TokenUsage,
  durationMs: number,
  details?: {
    readonly purpose: "classifier";
    readonly provider: string;
    readonly model: string;
  },
): Effect.Effect<void> {
  return emitTelemetry((telemetry) =>
    telemetry.recordLLMUsage({
      provider: details?.provider ?? metrics.provider ?? "unknown",
      model: details?.model ?? metrics.model ?? "unknown",
      usage,
      agentId: metrics.agentId,
      conversationId: metrics.conversationId,
      durationMs,
      runId: metrics.runId,
      ...(details?.purpose ? { purpose: details.purpose } : {}),
    }),
  );
}

/** Emit `llm_retry`. Best-effort. Call after `recordLLMRetry` bumps the count. */
export function emitLLMRetry(metrics: AgentRunMetrics, error: unknown): Effect.Effect<void> {
  return emitTelemetry((telemetry) =>
    telemetry.recordLLMRetry({
      provider: metrics.provider ?? "unknown",
      model: metrics.model ?? "unknown",
      error: normalizeError(error),
      attempt: metrics.llmRetryCount,
      agentId: metrics.agentId,
      runId: metrics.runId,
    }),
  );
}

/** Emit `tool_invocation` / `tool_error` for a single tool call. Best-effort. */
export function emitToolInvocation(
  metrics: AgentRunMetrics,
  data: {
    readonly toolName: string;
    readonly success: boolean;
    readonly durationMs: number;
    readonly error?: unknown;
  },
): Effect.Effect<void> {
  return emitTelemetry((telemetry) =>
    telemetry.recordToolInvocation({
      toolName: data.toolName,
      success: data.success,
      durationMs: data.durationMs,
      ...(data.error !== undefined && { error: normalizeError(data.error) }),
      agentId: metrics.agentId,
      conversationId: metrics.conversationId,
      runId: metrics.runId,
    }),
  );
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim();
}

function pushError(metrics: AgentRunMetrics, error: unknown, context?: string): string {
  const normalized = normalizeError(error);
  const contextualized = context ? `${context}: ${normalized}` : normalized;
  metrics.errors.push(contextualized);
  if (metrics.currentIteration) {
    metrics.currentIteration.errors.push(contextualized);
  }
  return contextualized;
}
