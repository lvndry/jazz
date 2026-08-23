/**
 * @fileoverview What a run has spent so far.
 *
 * The loop prices a run once, at the end, on its way to building an `AgentResponse`. A run
 * that parks or fails never gets there, and reporting nothing for those would tell an
 * unattended deployment that the tokens it already burned were free. This prices the same
 * numbers from the metrics at any point mid-flight.
 */

import type { UsageCostPricing } from "@/core/utils/usage-cost";
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
