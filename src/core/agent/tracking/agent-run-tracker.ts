import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { type Agent } from "../../types";

export interface AgentRunTrackerContext {
  readonly agent: Agent;
  readonly conversationId: string;
  readonly userId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high";
  readonly maxIterations: number;
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
}

export function createAgentRunTracker(context: AgentRunTrackerContext): AgentRunTracker {
  const { agent, conversationId, userId, provider, model, reasoningEffort, maxIterations } = context;

  return {
    runId: randomUUID(),
    agentId: agent.id,
    agentName: agent.name,
    agentType: agent.config.agentType,
    agentUpdatedAt: agent.updatedAt,
    conversationId,
    userId,
    provider,
    model,
    reasoningEffort,
    maxIterations,
    startedAt: new Date(),
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    llmRetryCount: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolsUsed: new Set<string>(),
    toolCallCounts: {},
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
  tracker.lastError = normalizeError(error);
}

export function recordToolInvocation(tracker: AgentRunTracker, toolName: string): void {
  tracker.toolCalls += 1;
  tracker.toolsUsed.add(toolName);
  tracker.toolCallCounts[toolName] = (tracker.toolCallCounts[toolName] ?? 0) + 1;
}

export function recordToolError(tracker: AgentRunTracker, error: unknown): void {
  tracker.toolErrors += 1;
  tracker.lastError = normalizeError(error);
}

export function recordLastError(tracker: AgentRunTracker, error: unknown): void {
  tracker.lastError = normalizeError(error);
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
    tracker.lastError && tracker.lastError.trim().length > 0
      ? tracker.lastError.replace(/\s+/g, " ").trim()
      : undefined;

  return writeTokenUsageLog({
    runId: tracker.runId,
    agentId: tracker.agentId,
    agentName: tracker.agentName,
    agentType: tracker.agentType,
    agentUpdatedAt: tracker.agentUpdatedAt,
    conversationId: tracker.conversationId,
    ...(tracker.userId ? { userId: tracker.userId } : {}),
    provider: tracker.provider,
    model: tracker.model,
    reasoningEffort: tracker.reasoningEffort,
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
}

function writeTokenUsageLog(payload: TokenUsageLogPayload): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      const logsDir = path.resolve(process.cwd(), "logs");
      await mkdir(logsDir, { recursive: true });
      const logFilePath = path.join(logsDir, "agent-token-usage.log");
      const timestamp = new Date().toISOString();
      const safeAgentName = payload.agentName.replace(/"/g, '\\"');
      const safeLastError = payload.lastError ? payload.lastError.replace(/"/g, '\\"') : "none";
      const safeToolsUsed = `[${payload.toolsUsed.join(",")}]`;
      const safeToolCallCounts = JSON.stringify(payload.toolCallCounts);
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
      } toolsUsed=${safeToolsUsed} toolCallCounts=${safeToolCallCounts} startedAt=${payload.startedAt.toISOString()} endedAt=${payload.endedAt.toISOString()} durationMs=${payload.durationMs}\n`;
      await appendFile(logFilePath, line, { encoding: "utf8" });
    },
    catch: (error: unknown) =>
      new Error(
        `Failed to write token usage log: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

