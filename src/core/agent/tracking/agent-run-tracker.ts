import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type Agent } from "../../types";
import { isInstalledGlobally } from "../../utils/runtime-detection";

export interface AgentRunTrackerContext {
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

export interface AgentRunTracker {
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
}

export function createAgentRunTracker(context: AgentRunTrackerContext): AgentRunTracker {
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
  };
}

export function recordLLMUsage(
  tracker: AgentRunTracker,
  usage: { readonly promptTokens: number; readonly completionTokens: number },
): void {
  tracker.totalPromptTokens += usage.promptTokens;
  tracker.totalCompletionTokens += usage.completionTokens;
}

export function recordLLMRetry(tracker: AgentRunTracker, error: unknown): void {
  tracker.llmRetryCount += 1;
  tracker.lastError = pushError(tracker, error, "llm-retry");
}

export function beginIteration(tracker: AgentRunTracker, iterationNumber: number): void {
  const summary: AgentRunIterationSummary = {
    iteration: iterationNumber,
    toolCalls: 0,
    toolsUsed: new Set<string>(),
    toolCallCounts: {},
    errors: [],
    toolSequence: [],
  };
  tracker.currentIteration = summary;
  tracker.iterationSummaries.push(summary);
}

export function completeIteration(tracker: AgentRunTracker): void {
  tracker.currentIteration = undefined;
}

export function recordToolInvocation(tracker: AgentRunTracker, toolName: string): void {
  tracker.toolCalls += 1;
  tracker.toolsUsed.add(toolName);
  tracker.toolCallCounts[toolName] = (tracker.toolCallCounts[toolName] ?? 0) + 1;
  tracker.toolInvocationSequence.push(toolName);
  const current = tracker.currentIteration;

  if (current) {
    current.toolCalls += 1;
    current.toolsUsed.add(toolName);
    current.toolCallCounts[toolName] = (current.toolCallCounts[toolName] ?? 0) + 1;
    current.toolSequence.push(toolName);
  }
}

export function recordToolError(tracker: AgentRunTracker, toolName: string, error: unknown): void {
  tracker.toolErrors += 1;
  tracker.lastError = pushError(tracker, error, `tool:${toolName}`);
}

export function recordLastError(tracker: AgentRunTracker, error: unknown): void {
  tracker.lastError = pushError(tracker, error);
}

export function finalizeAgentRun(
  tracker: AgentRunTracker,
  details: {
    readonly iterationsUsed: number;
    readonly finished: boolean;
  },
): Effect.Effect<void, Error> {
  const endedAt = new Date();
  const durationMs = endedAt.getTime() - tracker.startedAt.getTime();
  const totalTokens = tracker.totalPromptTokens + tracker.totalCompletionTokens;
  const toolsUsedList = Array.from(tracker.toolsUsed.values()).sort();
  const sortedToolCallCounts: Record<string, number> = Object.fromEntries(
    Object.entries(tracker.toolCallCounts).sort(([a], [b]) => a.localeCompare(b)),
  );
  const sanitizedLastError =
    tracker.lastError && tracker.lastError.trim().length > 0 ? tracker.lastError : undefined;

  const iterationSummaries = tracker.iterationSummaries.map((summary) => ({
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
    runId: tracker.runId,
    agentId: tracker.agentId,
    agentName: tracker.agentName,
    agentType: tracker.agentType,
    agentUpdatedAt: tracker.agentUpdatedAt,
    conversationId: tracker.conversationId,
    ...(tracker.userId ? { userId: tracker.userId } : {}),
    ...(tracker.provider ? { provider: tracker.provider } : {}),
    ...(tracker.model ? { model: tracker.model } : {}),
    ...(tracker.reasoningEffort ? { reasoningEffort: tracker.reasoningEffort } : {}),
    promptTokens: tracker.totalPromptTokens,
    completionTokens: tracker.totalCompletionTokens,
    totalTokens,
    iterations: details.iterationsUsed,
    maxIterations: tracker.maxIterations,
    finished: details.finished,
    startedAt: tracker.startedAt,
    endedAt,
    durationMs,
    retryCount: tracker.llmRetryCount,
    ...(sanitizedLastError ? { lastError: sanitizedLastError } : {}),
    toolCalls: tracker.toolCalls,
    toolsUsed: toolsUsedList,
    toolErrors: tracker.toolErrors,
    toolCallCounts: sortedToolCallCounts,
    toolInvocationSequence: tracker.toolInvocationSequence,
    errors: tracker.errors,
    iterationSummaries,
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
}

function writeTokenUsageLog(payload: TokenUsageLogPayload): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      const logsDir = getLogsDirectory();
      await mkdir(logsDir, { recursive: true });
      const logFilePath = path.join(logsDir, "agent-token-usage.log");
      const timestamp = new Date().toISOString();
      const safeAgentName = payload.agentName.replace(/"/g, '\\"');
      const safeLastError = payload.lastError ? payload.lastError.replace(/"/g, '\\"') : "none";
      const safeToolsUsed = `[${payload.toolsUsed.join(",")}]`;
      const safeToolCallCounts = JSON.stringify(payload.toolCallCounts);
      const safeToolInvocationSequence = JSON.stringify(payload.toolInvocationSequence);
      const safeErrors = JSON.stringify(payload.errors);
      const safeIterationSummaries = JSON.stringify(payload.iterationSummaries);
      const line = `${timestamp} runId=${payload.runId} agentId=${payload.agentId} agentName="${safeAgentName}" agentType=${payload.agentType} agentUpdatedAt=${payload.agentUpdatedAt.toISOString()} conversationId=${payload.conversationId} userId=${
        payload.userId ?? "anonymous"
      } provider=${payload.provider ?? "unknown"} model=${payload.model ?? "unknown"} reasoningEffort=${
        payload.reasoningEffort ?? "disable"
      } iterations=${payload.iterations} maxIterations=${payload.maxIterations} finished=${payload.finished} retryCount=${
        payload.retryCount
      } lastError="${safeLastError}" promptTokens=${payload.promptTokens} completionTokens=${
        payload.completionTokens
      } totalTokens=${payload.totalTokens} toolCalls=${payload.toolCalls} toolErrors=${
        payload.toolErrors
      } toolsUsed=${safeToolsUsed} toolCallCounts=${safeToolCallCounts} toolInvocationSequence=${safeToolInvocationSequence} errors=${safeErrors} iterationSummaries=${safeIterationSummaries} startedAt=${payload.startedAt.toISOString()} endedAt=${payload.endedAt.toISOString()} durationMs=${payload.durationMs}\n`;
      await appendFile(logFilePath, line, { encoding: "utf8" });
    },
    catch: (error: unknown) =>
      new Error(
        `Failed to write token usage log: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim();
}

function pushError(tracker: AgentRunTracker, error: unknown, context?: string): string {
  const normalized = normalizeError(error);
  const contextualized = context ? `${context}: ${normalized}` : normalized;
  tracker.errors.push(contextualized);
  if (tracker.currentIteration) {
    tracker.currentIteration.errors.push(contextualized);
  }
  return contextualized;
}

let logsDirectoryCache: string | undefined;

function getLogsDirectory(): string {
  if (!logsDirectoryCache) {
    logsDirectoryCache = resolveLogsDirectory();
  }
  return logsDirectoryCache;
}

function resolveLogsDirectory(): string {
  // 1. Allow manual override via environment variable
  const override = process.env["JAZZ_LOG_DIR"];
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }

  // 2. Check if we're in a globally installed package
  //    Global npm/pnpm/bun/yarn packages are installed in specific directories
  if (isInstalledGlobally()) {
    // Global install: use ~/.jazz/logs
    const homeDir = os.homedir();
    if (homeDir && homeDir.trim().length > 0) {
      return path.join(homeDir, ".jazz", "logs");
    }
  }

  // 3. Local development or local install: use cwd/logs
  return path.resolve(process.cwd(), "logs");
}
