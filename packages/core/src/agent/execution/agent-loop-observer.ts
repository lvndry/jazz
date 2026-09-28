import { Effect } from "effect";
import type { PresentationService } from "@/core/interfaces/presentation";
import { formatDuration } from "@/core/utils/duration";

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
  /**
   * The agent has tools, but none were sent because Jazz does not know the model
   * supports tool calling. Fired once per run, at the first such request.
   */
  onToolsDisabled(
    agentName: string,
    provider: string,
    model: string,
  ): Effect.Effect<void, never, never>;
  /** The final answer was cut off (`length`) or withheld by a content filter. */
  onAnswerIncomplete(
    agentName: string,
    finishReason: "length" | "content-filter",
  ): Effect.Effect<void, never, never>;
  /** The agent kept repeating the same tool calls after being told to change approach. */
  onStalled(agentName: string): Effect.Effect<void, never, never>;
  /** Compaction was needed but could not run or failed; older history is trimmed instead. */
  onCompactionUnavailable(agentName: string, reason: string): Effect.Effect<void, never, never>;
  /** The provider rejected a request as too long for the model; history is shrunk to retry. */
  onContextOverflow(agentName: string): Effect.Effect<void, never, never>;
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
  /**
   * Older tool results were compacted to free context, once per run. `pluginName` credits the
   * plugin that decided what to prune, or is undefined when the built-in clearer ran.
   */
  onToolResultsCompacted(
    agentName: string,
    pluginName: string | undefined,
    tokensReclaimed: number,
  ): Effect.Effect<void, never, never>;
  onCompletion(agentName: string): Effect.Effect<void, never, never>;
}

/**
 * The warning for a run whose model was sent no tools. Loud on purpose: the
 * agent cannot act, only talk, and nothing else in the answer says so.
 */
export function toolsDisabledWarning(provider: string, model: string): string {
  return (
    `TOOLS ARE OFF: ${provider}/${model} was sent no tools because Jazz does not know it supports tool calling, so this agent can only reply in text. ` +
    `If the model does support tools, run: jazz config set 'llm.capabilityOverrides.${provider}."${model}".supportsTools' true`
  );
}

/** Default observer: forwards loop lifecycle events to the PresentationService. */
export function makeDefaultObserver(presentation: PresentationService): AgentLoopObserver {
  return {
    onThinking: (agentName, isFirstIteration) =>
      presentation.presentThinking(agentName, isFirstIteration),
    onInterrupted: (agentName) =>
      presentation.presentInterrupted === undefined
        ? presentation.presentWarning(agentName, "generation stopped by user")
        : presentation.presentInterrupted(agentName),
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
        `time budget reached (${formatDuration(elapsedMs)} elapsed, limit ${formatDuration(maxDurationMs)}) - run stopped`,
      ),
    onEmptyResponse: (agentName) =>
      presentation.presentWarning(agentName, "model returned an empty response"),
    onToolsDisabled: (agentName, provider, model) =>
      presentation.presentWarning(agentName, toolsDisabledWarning(provider, model)),
    onAnswerIncomplete: (agentName, finishReason) =>
      presentation.presentWarning(
        agentName,
        finishReason === "length"
          ? "the answer was cut off at the model's output limit"
          : "the provider's content filter withheld the answer",
      ),
    onCompactionUnavailable: (agentName, reason) =>
      presentation.presentWarning(
        agentName,
        `could not compact the conversation (${reason}) - trimming older messages instead`,
      ),
    onContextOverflow: (agentName) =>
      presentation.presentWarning(
        agentName,
        "the model rejected the request as too long for its context - shrinking history and retrying once",
      ),
    onStalled: (agentName) =>
      presentation.presentWarning(
        agentName,
        "kept repeating the same tool calls after being told to change approach - run stopped",
      ),
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
    onToolResultsCompacted: (agentName, pluginName, tokensReclaimed) =>
      presentation.presentStatus(
        pluginName === undefined
          ? `Freed ~${tokensReclaimed.toLocaleString()} tokens by compacting older tool results`
          : `Freed ~${tokensReclaimed.toLocaleString()} tokens — older tool results compacted by the ${pluginName} plugin`,
        "success",
        agentName,
      ),
    onCompletion: (agentName) => presentation.presentCompletion(agentName),
  };
}
