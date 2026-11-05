import { Effect } from "effect";
import type { LoggerService } from "@/core/interfaces/logger";
import type { StreamEvent } from "@/core/types/streaming";
import type { ToolDefinition } from "@/core/types/tools";
import type { AgentRunMetrics } from "./agent-run-metrics";
import {
  cacheHitRate,
  fingerprintRequest,
  observeRequest,
  recordCacheUsage,
  toolFingerprintInput,
  type CacheUsageInput,
} from "./prompt-cache";

export interface PromptCacheScope {
  readonly logger: LoggerService;
  readonly runMetrics: AgentRunMetrics;
  readonly conversationKey: string;
  readonly provider: string;
  readonly model: string;
  /** Receives the `prompt_cache` event; absent for nested runs, whose renderer is the parent's. */
  readonly emit: ((event: StreamEvent) => Effect.Effect<void>) | undefined;
}

/**
 * Fingerprint the request about to be sent, classify what changed against the conversation's
 * previous request, and tell the renderer. Never logs prompt or tool content, only hashes.
 */
export function observePromptCache(
  scope: PromptCacheScope,
  tools: readonly ToolDefinition[],
  messages: readonly { readonly role: string; readonly kind?: string }[],
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const fingerprint = fingerprintRequest({
      provider: scope.provider,
      model: scope.model,
      tools: tools.map(toolFingerprintInput),
      messages,
    });
    const change = observeRequest(scope.conversationKey, fingerprint);
    scope.runMetrics.lastCacheReason = change.reason;
    yield* scope.logger.debug("Prompt cache prefix classified", {
      conversationId: scope.runMetrics.conversationId,
      reason: change.reason,
      changed: change.changed,
      toolsHash: fingerprint.toolsHash,
      systemHash: fingerprint.systemHash,
      historyHash: fingerprint.historyHash,
      toolCount: tools.length,
      messageCount: fingerprint.messageHashes.length,
    });
    if (scope.emit !== undefined) {
      yield* scope.emit({ type: "prompt_cache", reason: change.reason, changed: change.changed });
    }
  });
}

/** Attach the provider's cache figures to the request just classified and log the hit rate. */
export function recordPromptCacheUsage(
  scope: Pick<PromptCacheScope, "logger" | "runMetrics" | "conversationKey">,
  usage: CacheUsageInput,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    recordCacheUsage(scope.conversationKey, usage);
    const hitRate = cacheHitRate(usage);
    yield* scope.logger.debug("Prompt cache usage recorded", {
      conversationId: scope.runMetrics.conversationId,
      reason: scope.runMetrics.lastCacheReason,
      hitRate: hitRate === undefined ? "unknown" : Number(hitRate.toFixed(4)),
      promptTokens: usage.promptTokens,
      ...(usage.cacheReadTokens !== undefined && { cacheReadTokens: usage.cacheReadTokens }),
      ...(usage.cacheWriteTokens !== undefined && { cacheWriteTokens: usage.cacheWriteTokens }),
    });
  });
}
