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
import type { RunRecord } from "./run-record";
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

/** What one run spent, as its run record reports it. */
export interface RunSpend {
  readonly totalTokens: number;
  /** Undefined when the run's provider has no pricing. */
  readonly costUSD?: number;
  readonly activeDurationMs: number;
}

export function runSpend(
  run: Pick<RunRecord, "totalTokens" | "costUSD" | "activeDurationMs">,
): RunSpend {
  return {
    totalTokens: run.totalTokens ?? 0,
    ...(run.costUSD !== undefined ? { costUSD: run.costUSD } : {}),
    activeDurationMs: run.activeDurationMs ?? 0,
  };
}

/** Spend accumulated across runs by something that outlives them (a goal, a loop). */
export interface SpendTotals {
  readonly totalTokens: number;
  /** Omitted while any contributing run has unknown pricing. */
  readonly costUSD?: number;
  readonly costKnown: boolean;
  readonly activeDurationMs: number;
}

/**
 * Fold one run's spend into running totals. Totals only grow, and once any run had no
 * pricing the cost stays unknown: a partial sum reported as the total would understate it.
 */
export function addRunSpend<Totals extends SpendTotals>(totals: Totals, spend: RunSpend): Totals {
  const costKnown = totals.costKnown && spend.costUSD !== undefined;
  const { costUSD: _previousCost, ...rest } = totals;
  return {
    ...rest,
    totalTokens: totals.totalTokens + spend.totalTokens,
    activeDurationMs: totals.activeDurationMs + spend.activeDurationMs,
    costKnown,
    ...(costKnown ? { costUSD: (totals.costUSD ?? 0) + (spend.costUSD ?? 0) } : {}),
  } as Totals;
}

/** The spend caps something that outlives its runs (a goal, a loop) holds its runs to. */
export interface SpendBudget {
  readonly maxTokens: number;
  readonly maxDurationMs: number;
  /** A dollar cap binds only while the totals' cost is known. */
  readonly maxCostUSD?: number;
}

export type SpendLimit = "tokens" | "duration" | "cost";

const NO_RUN_SPEND: RunSpend = { totalTokens: 0, activeDurationMs: 0 };

/**
 * What a run may still spend under `budget`, after the recorded totals and `inFlight`, the spend
 * of a parked run about to resume that is not folded into the totals yet. A cap at or below zero
 * is a reached limit, reported as the first one in tokens, duration, cost order.
 */
export function remainingSpendCaps(
  budget: SpendBudget,
  totals: SpendTotals,
  inFlight: RunSpend = NO_RUN_SPEND,
):
  | { readonly kind: "caps"; readonly caps: SpendBudget }
  | { readonly kind: "limit"; readonly limit: SpendLimit } {
  const tokens = budget.maxTokens - totals.totalTokens - inFlight.totalTokens;
  if (tokens <= 0) {
    return { kind: "limit", limit: "tokens" };
  }
  const duration = budget.maxDurationMs - totals.activeDurationMs - inFlight.activeDurationMs;
  if (duration <= 0) {
    return { kind: "limit", limit: "duration" };
  }
  let maxCostUSD: number | undefined;
  if (budget.maxCostUSD !== undefined && totals.costKnown) {
    maxCostUSD = budget.maxCostUSD - (totals.costUSD ?? 0) - (inFlight.costUSD ?? 0);
    if (maxCostUSD <= 0) {
      return { kind: "limit", limit: "cost" };
    }
  }
  return {
    kind: "caps",
    caps: {
      maxTokens: tokens,
      maxDurationMs: duration,
      ...(maxCostUSD !== undefined ? { maxCostUSD } : {}),
    },
  };
}

/** The first spend cap the totals have reached, or undefined while another run may start. */
export function spendLimitReached(
  budget: SpendBudget,
  totals: SpendTotals,
): SpendLimit | undefined {
  const remaining = remainingSpendCaps(budget, totals);
  return remaining.kind === "limit" ? remaining.limit : undefined;
}

/**
 * Raise every spend cap so there is `room` beyond what has been spent, counting `inFlight`, a
 * parked run's spend not folded in yet: extending from the totals alone would leave that run
 * still over the cap. A budget without a dollar cap stays without one.
 */
export function extendSpendBudget(
  budget: SpendBudget,
  totals: SpendTotals,
  room: SpendBudget,
  inFlight: RunSpend = NO_RUN_SPEND,
): SpendBudget {
  const spentUSD = (totals.costUSD ?? 0) + (inFlight.costUSD ?? 0);
  return {
    maxTokens: Math.max(
      budget.maxTokens,
      totals.totalTokens + inFlight.totalTokens + room.maxTokens,
    ),
    maxDurationMs: Math.max(
      budget.maxDurationMs,
      totals.activeDurationMs + inFlight.activeDurationMs + room.maxDurationMs,
    ),
    ...(budget.maxCostUSD !== undefined
      ? { maxCostUSD: Math.max(budget.maxCostUSD, spentUSD + (room.maxCostUSD ?? 0)) }
      : {}),
  };
}
