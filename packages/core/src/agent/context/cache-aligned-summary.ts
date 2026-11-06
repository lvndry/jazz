/**
 * The compaction summary as one more request of the conversation: the run's own system prompt,
 * tool schemas and messages exactly as the previous request sent them, then one final user
 * message asking for the checkpoint. The provider serves that prefix from the prompt cache the
 * previous request wrote, where a summarizer agent with its own persona and the transcript
 * pasted in as text shares no prefix with anything and is billed as fully uncached input.
 *
 * Only a request that really does share the previous request's prefix is sent this way; every
 * other case returns a fallback and the caller runs the stand-alone summarizer instead.
 */

import { Duration, Effect } from "effect";
import { LLM_TIMEOUT_SECONDS } from "@/core/constants/agent";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { Agent } from "@/core/types";
import type { ChatCompletionResponse } from "@/core/types/chat";
import type { ChatMessage } from "@/core/types/message";
import type { ToolDefinition } from "@/core/types/tools";
import type { UsageCostPricing } from "@/core/utils/usage-cost";
import { buildCompletionOptions } from "../execution/completion-request";
import {
  createAgentRunMetrics,
  recordLLMUsage,
  recordFailedAttempt,
  recordSideSpend,
  runSpendReport,
  telemetryErrorCategory,
} from "../metrics/agent-run-metrics";
import { fingerprintRequest, peekCacheChange, toolFingerprintInput } from "../metrics/prompt-cache";
import {
  observePromptCache,
  recordPromptCacheUsage,
  type PromptCacheScope,
} from "../metrics/prompt-cache-observer";

/**
 * Share of the context window kept free for the checkpoint the request asks for. The summarize
 * request carries the whole history, so it must leave room to answer; a checkpoint is a few
 * thousand tokens, which 10% covers on every window from 32K up.
 */
export const ALIGNED_SUMMARY_OUTPUT_RESERVE_RATIO = 0.1;

/**
 * What the agent loop hands compaction so the summary can reuse the conversation's request:
 * the exact tool list the previous request offered, and the scope that request was fingerprinted
 * under (which also owns the run's metrics, so the summary's spend lands in them).
 */
export interface CacheAlignedSummary {
  readonly tools: ToolDefinition[];
  readonly cacheScope: PromptCacheScope;
  readonly pricing: UsageCostPricing | undefined;
}

export type AlignedSummaryOutcome =
  | {
      readonly kind: "summary";
      readonly content: string;
      readonly finishReason: ChatCompletionResponse["finishReason"];
    }
  | { readonly kind: "fallback"; readonly reason: string };

export interface AlignedSummaryRequest {
  readonly alignment: CacheAlignedSummary;
  readonly agent: Agent;
  readonly history: readonly ChatMessage[];
  readonly instruction: string;
}

/**
 * Why a summary cannot be sent as a conversation request, or undefined when it can. Reuse needs
 * the provider's own model (a different summarizer model has a different cache), a provider that
 * prices cache reads (the catalog's signal that it caches prompts at all), a provider that runs
 * Jazz's tool loop itself rather than answering one request, and room in the window for the
 * whole history plus the checkpoint.
 */
export function alignedSummaryBlocker(input: {
  readonly summarizerModel: { readonly provider: string; readonly model: string };
  readonly agent: Agent;
  readonly pricing: UsageCostPricing | undefined;
  readonly requestTokens: number;
  readonly contextWindowTokens: number;
}): string | undefined {
  const { summarizerModel, agent, pricing, requestTokens, contextWindowTokens } = input;
  const { provider, model } = agent.config.llm;
  if (summarizerModel.provider !== provider || summarizerModel.model !== model) {
    return "summarizer-model-differs";
  }
  if (provider === "claude_code") {
    return "provider-owns-tool-loop";
  }
  if (pricing?.cacheReadPricePerMillion === undefined) {
    return "no-prompt-caching";
  }
  if (requestTokens > contextWindowTokens * (1 - ALIGNED_SUMMARY_OUTPUT_RESERVE_RATIO)) {
    return "request-too-large";
  }
  return undefined;
}

/**
 * Send the summary as the conversation's next request. Returns a fallback, with the reason,
 * for anything that makes the stand-alone summarizer the better choice: a prefix that is not an
 * unchanged append of the previous request (it would not hit the cache, so it would be the same
 * uncached call with none of the stand-alone path's chunking), a failed request, or a model that
 * called a tool despite `toolChoice: "none"` (the call is discarded, never run).
 *
 * The call is accounted like the stand-alone summarizer's: its spend is folded into the run as
 * side spend, and its cache figures go through the same hit-rate computation as any request.
 */
export function requestAlignedSummary(
  request: AlignedSummaryRequest,
): Effect.Effect<AlignedSummaryOutcome, never, LLMService | LoggerService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const llmService = yield* LLMServiceTag;
    const { alignment, agent, history, instruction } = request;
    const { cacheScope, tools, pricing } = alignment;
    const messages: ChatMessage[] = [
      ...history,
      { role: "user", content: instruction, kind: "ephemeral" },
    ];

    const change = peekCacheChange(
      cacheScope.conversationKey,
      fingerprintRequest({
        provider: cacheScope.provider,
        model: cacheScope.model,
        tools: tools.map(toolFingerprintInput),
        messages,
      }),
    );
    if (change.reason !== "none") {
      yield* logger.debug("Compaction summary cannot reuse the conversation prefix", {
        conversationId: cacheScope.runMetrics.conversationId,
        reason: change.reason,
        changed: change.changed,
      });
      return { kind: "fallback", reason: `prefix-${change.reason}` } as const;
    }

    const summaryCacheScope: PromptCacheScope = { ...cacheScope, emit: undefined };
    yield* observePromptCache(summaryCacheScope, tools, messages);
    const startedAt = Date.now();
    const attempt = yield* llmService
      .createChatCompletion(
        agent.config.llm.provider,
        buildCompletionOptions({
          agent,
          model: cacheScope.model,
          tools,
          messages,
          toolChoice: "none",
          conversationId: cacheScope.runMetrics.conversationId,
        }),
      )
      .pipe(Effect.timeout(Duration.seconds(LLM_TIMEOUT_SECONDS)), Effect.result);
    if (attempt._tag === "Failure") {
      recordFailedAttempt(
        cacheScope.runMetrics,
        {
          error: attempt.failure,
          mode: "non_streaming",
          provider: cacheScope.provider,
          model: cacheScope.model,
          durationMs: Date.now() - startedAt,
          streamedChars: 0,
          toolCallStarted: false,
        },
        false,
      );
      yield* logger.warn("Cache-aligned compaction summary request failed", {
        conversationId: cacheScope.runMetrics.conversationId,
        errorCategory: telemetryErrorCategory(attempt.failure),
      });
      return { kind: "fallback", reason: "request-failed" } as const;
    }
    const completion = attempt.success;

    const summaryMetrics = createAgentRunMetrics({
      agent,
      conversationId: cacheScope.runMetrics.conversationId,
      provider: cacheScope.provider,
      model: cacheScope.model,
    });
    if (completion.usage !== undefined) {
      recordLLMUsage(summaryMetrics, completion.usage);
      yield* recordPromptCacheUsage(summaryCacheScope, completion.usage);
    } else {
      summaryMetrics.usageMissing = true;
    }
    recordSideSpend(cacheScope.runMetrics, runSpendReport(summaryMetrics, pricing));
    yield* logger.debug("Cache-aligned compaction summary received", {
      conversationId: cacheScope.runMetrics.conversationId,
      durationMs: Date.now() - startedAt,
      contentLength: completion.content.length,
      toolCallsCount: completion.toolCalls?.length ?? 0,
      finishReason: completion.finishReason,
    });

    if (completion.toolCalls !== undefined && completion.toolCalls.length > 0) {
      yield* logger.warn("Compaction summary request returned tool calls; discarding them", {
        conversationId: cacheScope.runMetrics.conversationId,
        toolCallsCount: completion.toolCalls.length,
      });
      return { kind: "fallback", reason: "tool-call-returned" } as const;
    }
    return {
      kind: "summary",
      content: completion.content,
      finishReason: completion.finishReason,
    } as const;
  });
}
