/**
 * @fileoverview What a run, or a one-off model call outside a run, has spent.
 *
 * The loop prices a run once, at the end, on its way to building an `AgentResponse`. A run
 * that parks or fails never gets there, and reporting nothing for those would tell an
 * unattended deployment that the tokens it already burned were free. This prices the same
 * numbers from the metrics at any point mid-flight.
 */

import { Effect } from "effect";
import { isZeroCostLocalModel } from "@/core/constants/local-providers";
import type { Agent } from "@/core/types";
import { getModelsDevMetadata } from "@/core/utils/models-dev";
import type { UsageCostPricing, UsageCostTokens } from "@/core/utils/usage-cost";
import { computeUsageCostUSD } from "@/core/utils/usage-cost";
import type { createAgentRunMetrics } from "../metrics/agent-run-metrics";

export function runSpendUSD(
  metrics: ReturnType<typeof createAgentRunMetrics>,
  pricing: UsageCostPricing | undefined,
): number | undefined {
  const own = computeUsageCostUSD(
    {
      promptTokens: metrics.totalPromptTokens,
      completionTokens: metrics.totalCompletionTokens,
      cacheReadTokens: metrics.totalCacheReadTokens,
    },
    pricing,
  );
  if (own === null && metrics.childCostUSD <= 0) return undefined;
  return parseFloat(((own ?? 0) + metrics.childCostUSD).toFixed(8));
}

/**
 * Distinguish unavailable remote pricing from providers that run on the user's machine.
 * `costIncomplete` comes from the run itself and wins over a defined costUSD: a total that
 * omits unpriced parent or sub-agent spend is not known.
 */
export function isRunCostKnown(
  costUSD: number | undefined,
  provider: string,
  modelId: string,
  costIncomplete = false,
): boolean {
  if (costIncomplete) return false;
  if (costUSD !== undefined) return true;
  return isZeroCostLocalModel(provider, modelId);
}

export interface CallSpend {
  readonly totalTokens: number;
  /** Absent when the call's cost is unknown. */
  readonly costUSD?: number;
  readonly costKnown: boolean;
}

function spendOf(totalTokens: number, costUSD: number | undefined): CallSpend {
  return costUSD === undefined
    ? { totalTokens, costKnown: false }
    : { totalTokens, costUSD, costKnown: true };
}

/**
 * What one model call made outside an agent run cost, priced the way run metrics price a run:
 * free on a local model, from models.dev otherwise, and unknown when neither applies. A call
 * that reported no usage (it failed) has unknown cost.
 */
export function priceOneOffCall(
  agent: Pick<Agent, "config">,
  usage: (UsageCostTokens & { readonly totalTokens: number }) | undefined,
): Effect.Effect<CallSpend> {
  return Effect.gen(function* () {
    if (usage === undefined) {
      return spendOf(0, undefined);
    }
    const { llmProvider, llmModel } = agent.config;
    if (isZeroCostLocalModel(llmProvider, llmModel)) {
      return spendOf(usage.totalTokens, 0);
    }
    const pricing = yield* Effect.tryPromise(() =>
      getModelsDevMetadata(llmModel, llmProvider),
    ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    return spendOf(usage.totalTokens, computeUsageCostUSD(usage, pricing) ?? undefined);
  });
}

/** What a finished agent run cost, from its response. */
export function agentRunSpend(
  agent: Pick<Agent, "config">,
  response: {
    readonly usage?: { readonly promptTokens: number; readonly completionTokens: number };
    readonly costUSD?: number;
    readonly costIncomplete?: boolean;
  },
): CallSpend {
  const totalTokens = (response.usage?.promptTokens ?? 0) + (response.usage?.completionTokens ?? 0);
  const known = isRunCostKnown(
    response.costUSD,
    agent.config.llmProvider,
    agent.config.llmModel,
    response.costIncomplete === true,
  );
  return spendOf(totalTokens, known ? (response.costUSD ?? 0) : undefined);
}
