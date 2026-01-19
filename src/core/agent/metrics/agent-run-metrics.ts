import { Effect } from "effect";
import { randomUUID } from "node:crypto";

import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { type Agent } from "@/core/types";

export interface AgentRunMetricsContext {
  readonly agent: Agent;
  readonly conversationId: string;
  readonly userId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high";
  readonly maxIterations: number;
}

interface AgentRunIterationSummary {
  readonly iteration: number;
  toolCalls: number;
  readonly toolsUsed: Set<string>;
  readonly toolCallCounts: Record<string, number>;
  readonly errors: string[];
  readonly toolSequence: string[];
}

export interface AgentRunMetrics {
  readonly runId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly agentType: string;
  readonly agentUpdatedAt: Date;
  readonly conversationId: string;
  readonly userId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high";
  readonly maxIterations: number;
  readonly startedAt: Date;
  totalPromptTokens: number;
  totalCompletionTokens: number;
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
}

export function createAgentRunMetrics(context: AgentRunMetricsContext): AgentRunMetrics {
  const { agent, conversationId, userId, provider, model, reasoningEffort, maxIterations } =
    context;

  return {
    runId: randomUUID(),
    agentId: agent.id,
    agentName: agent.name,
    agentType: agent.config.agentType,
    agentUpdatedAt: agent.updatedAt,
    conversationId,
    ...(userId ? { userId } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    maxIterations,
    startedAt: new Date(),
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
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
  };
}

export function recordLLMUsage(
  metrics: AgentRunMetrics,
  usage: { readonly promptTokens: number; readonly completionTokens: number },
): void {
  metrics.totalPromptTokens += usage.promptTokens;
  metrics.totalCompletionTokens += usage.completionTokens;
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
  }));

  return writeTokenUsageLog({
    runId: metrics.runId,
    agentId: metrics.agentId,
    agentName: metrics.agentName,
    agentType: metrics.agentType,
    agentUpdatedAt: metrics.agentUpdatedAt,
    conversationId: metrics.conversationId,
    ...(metrics.userId ? { userId: metrics.userId } : {}),
    ...(metrics.provider ? { provider: metrics.provider } : {}),
    ...(metrics.model ? { model: metrics.model } : {}),
    ...(metrics.reasoningEffort ? { reasoningEffort: metrics.reasoningEffort } : {}),
    promptTokens: metrics.totalPromptTokens,
    completionTokens: metrics.totalCompletionTokens,
    totalTokens,
    iterations: details.iterationsUsed,
    maxIterations: metrics.maxIterations,
    finished: details.finished,
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
  });
}

interface TokenUsageLogPayload {
  readonly runId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly agentType: string;
  readonly agentUpdatedAt: Date;
  readonly conversationId: string;
  readonly userId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high";
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly iterations: number;
  readonly maxIterations: number;
  readonly finished: boolean;
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
  }[];
  readonly firstTokenLatencyMs?: number;
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
      agentType: payload.agentType,
      agentUpdatedAt: payload.agentUpdatedAt.toISOString(),
      conversationId: payload.conversationId,
      userId: payload.userId ?? "anonymous",
      provider: payload.provider ?? "unknown",
      model: payload.model ?? "unknown",
      reasoningEffort: payload.reasoningEffort ?? "disable",
      iterations: payload.iterations,
      maxIterations: payload.maxIterations,
      finished: payload.finished,
      retryCount: payload.retryCount,
      ...(payload.lastError ? { lastError: payload.lastError } : {}),
      promptTokens: payload.promptTokens,
      completionTokens: payload.completionTokens,
      totalTokens: payload.totalTokens,
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
    };

    yield* logger.info("Agent token usage", logMeta);
  });
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
