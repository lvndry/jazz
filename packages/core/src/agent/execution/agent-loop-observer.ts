import { Effect } from "effect";
import type { PresentationService } from "@/core/interfaces/presentation";

/**
 * Lifecycle events the agent loop emits. Kept separate from PresentationService
 * so the loop is decoupled from the in-process presentation layer — a headless
 * server (PR 2) implements this to serialize lifecycle events over the wire.
 */
export interface AgentLoopObserver {
  onThinking(agentName: string, isFirstIteration: boolean): Effect.Effect<void, never, never>;
  onInterrupted(agentName: string): Effect.Effect<void, never, never>;
  onIterationLimit(agentName: string, maxIterations: number): Effect.Effect<void, never, never>;
  /** Cumulative run cost (own + sub-agent spend) reached the configured `maxCostUSD` cap. */
  onCostCapReached(
    agentName: string,
    maxCostUSD: number,
    costUSD: number,
  ): Effect.Effect<void, never, never>;
  /** Cumulative own tokens reached the configured `maxTokens` cap. */
  onTokenCapReached(
    agentName: string,
    maxTokens: number,
    totalTokens: number,
  ): Effect.Effect<void, never, never>;
  /** Wall-clock elapsed time reached the configured `maxDurationMs` budget. */
  onDurationCapReached(
    agentName: string,
    maxDurationMs: number,
    elapsedMs: number,
  ): Effect.Effect<void, never, never>;
  onEmptyResponse(agentName: string): Effect.Effect<void, never, never>;
  /** The agent runs on a local server whose real context window Jazz could not determine. */
  onContextWindowUnknown(agentName: string, advice: string): Effect.Effect<void, never, never>;
  /**
   * History was trimmed — messages discarded without being summarized. This is the
   * backstop firing, which means compaction could not bring the run under budget.
   */
  onHistoryTrimmed(agentName: string, messagesRemoved: number): Effect.Effect<void, never, never>;
  /** The conversation passed the warn threshold; compaction has not run yet. */
  onContextPressure(
    agentName: string,
    percentUsed: number,
    budgetTokens: number,
  ): Effect.Effect<void, never, never>;
  onCompletion(agentName: string): Effect.Effect<void, never, never>;
}

/** Default observer: forwards loop lifecycle events to the PresentationService. */
export function makeDefaultObserver(presentation: PresentationService): AgentLoopObserver {
  return {
    onThinking: (agentName, isFirstIteration) =>
      presentation.presentThinking(agentName, isFirstIteration),
    onInterrupted: (agentName) =>
      presentation.presentWarning(agentName, "generation stopped by user"),
    onIterationLimit: (agentName, maxIterations) =>
      presentation.presentWarning(
        agentName,
        `iteration limit reached (${maxIterations}) - type 'continue' to resume`,
      ),
    onCostCapReached: (agentName, maxCostUSD, costUSD) =>
      presentation.presentWarning(
        agentName,
        `cost cap reached ($${costUSD.toFixed(4)} spent, limit $${maxCostUSD.toFixed(4)}) - run stopped`,
      ),
    onTokenCapReached: (agentName, maxTokens, totalTokens) =>
      presentation.presentWarning(
        agentName,
        `token cap reached (${totalTokens.toLocaleString()} tokens, limit ${maxTokens.toLocaleString()}) - run stopped`,
      ),
    onDurationCapReached: (agentName, maxDurationMs, elapsedMs) =>
      presentation.presentWarning(
        agentName,
        `time budget reached (${Math.round(elapsedMs / 60_000)} min elapsed, limit ${Math.round(maxDurationMs / 60_000)} min) - run stopped`,
      ),
    onEmptyResponse: (agentName) =>
      presentation.presentWarning(agentName, "model returned an empty response"),
    onContextWindowUnknown: (agentName, advice) => presentation.presentWarning(agentName, advice),
    onHistoryTrimmed: (agentName, messagesRemoved) =>
      presentation.presentWarning(
        agentName,
        `context still over budget after compacting — dropped ${messagesRemoved} older message(s) without summarizing them`,
      ),
    onContextPressure: (agentName, percentUsed, budgetTokens) =>
      presentation.presentWarning(
        agentName,
        `context ${percentUsed}% full of ${budgetTokens.toLocaleString()} tokens — will auto-compact soon`,
      ),
    onCompletion: (agentName) => presentation.presentCompletion(agentName),
  };
}
