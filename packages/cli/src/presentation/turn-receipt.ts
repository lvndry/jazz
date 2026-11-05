/**
 * The totals a whole turn pays for, summed across every model step it took.
 *
 * A turn that calls tools is several model requests; the transcript closes it
 * with one quiet receipt — `12.3s · 4 steps · 65k in → 416 out · $0.08 · 07:28 am` —
 * rather than a line after every request.
 */

import {
  describeCacheReason,
  formatCacheSummary,
  normalizeCacheUsage,
  type CacheMissReason,
} from "@jazz/core/agent/metrics/prompt-cache";
import { formatCompactCount } from "@jazz/core/utils/string";
import { formatClockTime, formatCost, formatPreciseDuration } from "../ui/text/format";

export type StepStats = import("@jazz/core/types/presentation-content").PresentationStepStats;

export interface TurnTotals {
  readonly steps: readonly StepStats[];
  /** Epoch ms when the turn's last step completed, shown as its wall-clock finish time. */
  readonly finishedAt?: number;
}

export const EMPTY_TURN: TurnTotals = { steps: [] };

export function addStep(turn: TurnTotals, step: StepStats): TurnTotals {
  return { ...turn, steps: [...turn.steps, step] };
}

function sum(
  steps: readonly StepStats[],
  pick: (step: StepStats) => number | undefined,
): number | undefined {
  let total: number | undefined;
  for (const step of steps) {
    const value = pick(step);
    if (value !== undefined) {
      total = (total ?? 0) + value;
    }
  }
  return total;
}

/**
 * The cache fields of a step, from one request's usage. Empty when the provider reported no
 * cache fields: that is unknown, so it never shows as 0%.
 */
export function cacheStepFields(
  usage: {
    readonly promptTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  },
  reason: CacheMissReason | undefined,
): Pick<StepStats, "cacheReadTokens" | "cacheInputTokens" | "cacheMissReason"> {
  const normalized = normalizeCacheUsage(usage);
  if (normalized === undefined) {
    return {};
  }
  return {
    cacheReadTokens: normalized.cacheReadTokens,
    cacheInputTokens: normalized.totalInputTokens,
    ...(reason !== undefined && { cacheMissReason: reason }),
  };
}

/**
 * A step's cache reads and the input they are a share of. Receipts saved before steps carried
 * `cacheInputTokens` recorded 0 for a provider that reported nothing, so there a 0 is unknown
 * and a positive count is read against the prompt (the subset convention they were made under).
 */
function stepCacheShare(
  step: StepStats,
): { readonly read: number; readonly input: number } | undefined {
  if (step.cacheReadTokens === undefined) {
    return undefined;
  }
  if (step.cacheInputTokens === undefined) {
    return step.cacheReadTokens > 0 && (step.promptTokens ?? 0) > 0
      ? { read: step.cacheReadTokens, input: step.promptTokens ?? 0 }
      : undefined;
  }
  return step.cacheInputTokens > 0
    ? { read: step.cacheReadTokens, input: step.cacheInputTokens }
    : undefined;
}

/** One request's cache figure for a plain-text summary, or undefined when unreported. */
export function formatRequestCache(
  usage: {
    readonly promptTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  },
  reason: CacheMissReason | undefined,
): string | undefined {
  const normalized = normalizeCacheUsage(usage);
  if (normalized === undefined || normalized.totalInputTokens <= 0) {
    return undefined;
  }
  return formatCacheSummary(normalized.cacheReadTokens / normalized.totalInputTokens, reason);
}

function stepHitRate(step: StepStats): number | undefined {
  const share = stepCacheShare(step);
  return share === undefined ? undefined : share.read / share.input;
}

/**
 * The turn's cache figure, weighted by input tokens across the steps that reported cache
 * fields, with the reason of its worst step when the turn missed. Undefined when no step
 * reported cache fields.
 */
function cachePart(steps: readonly StepStats[]): string | undefined {
  let inputTokens = 0;
  let readTokens = 0;
  let unreportedSteps = 0;
  let worst: { rate: number; reason: CacheMissReason | undefined } | undefined;
  for (const step of steps) {
    const share = stepCacheShare(step);
    if (share === undefined) {
      if ((step.promptTokens ?? 0) > 0) {
        unreportedSteps += 1;
      }
      continue;
    }
    const rate = share.read / share.input;
    inputTokens += share.input;
    readTokens += share.read;
    if (worst === undefined || rate < worst.rate) {
      worst = { rate, reason: step.cacheMissReason };
    }
  }
  if (worst === undefined || inputTokens <= 0) {
    return undefined;
  }
  return formatCacheSummary(readTokens / inputTokens, worst.reason, unreportedSteps > 0);
}

function tokenPart(
  promptTokens: number | undefined,
  completionTokens: number | undefined,
): string | undefined {
  if (promptTokens === undefined && completionTokens === undefined) {
    return undefined;
  }
  return `${formatCompactCount(promptTokens ?? 0)} in → ${formatCompactCount(completionTokens ?? 0)} out`;
}

/** Decode throughput weighted by measured generation time, never by step count. */
export function turnTokensPerSecond(turn: TurnTotals): number | undefined {
  let tokens = 0;
  let durationMs = 0;
  for (const step of turn.steps) {
    const count = step.completionTokens;
    if (count === undefined || !Number.isFinite(count) || count < 0) {
      return undefined;
    }
    if (count === 0) {
      continue;
    }
    const measured =
      step.generationDurationMs ??
      (step.tokensPerSecond !== undefined &&
      Number.isFinite(step.tokensPerSecond) &&
      step.tokensPerSecond > 0
        ? (count / step.tokensPerSecond) * 1000
        : undefined);
    if (measured === undefined || !Number.isFinite(measured) || measured <= 0) {
      return undefined;
    }
    tokens += count;
    durationMs += measured;
  }
  return tokens > 0 && durationMs > 0 ? (tokens / durationMs) * 1000 : undefined;
}

/** The one-row receipt that closes a turn, or undefined when there is nothing to say. */
export function formatTurnReceipt(turn: TurnTotals): string | undefined {
  const { steps } = turn;
  if (steps.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  const durationMs = sum(steps, (step) => step.durationMs) ?? 0;
  if (durationMs > 0) {
    parts.push(formatPreciseDuration(durationMs));
  }
  if (steps.length > 1) {
    parts.push(`${String(steps.length)} steps`);
  }
  const tokens = tokenPart(
    sum(steps, (step) => step.promptTokens),
    sum(steps, (step) => step.completionTokens),
  );
  if (tokens !== undefined) {
    parts.push(tokens);
  } else {
    const totalTokens = sum(steps, (step) => step.totalTokens);
    if (totalTokens !== undefined) {
      parts.push(`${formatCompactCount(totalTokens)} tok`);
    }
  }
  const cache = cachePart(steps);
  if (cache !== undefined) {
    parts.push(cache);
  }
  const throughput = turnTokensPerSecond(turn);
  if (throughput !== undefined) {
    parts.push(`${throughput.toFixed(1)} tok/s`);
  }
  const cost = sum(steps, (step) => step.costUSD);
  if (cost !== undefined) {
    parts.push(formatCost(cost));
  }
  if (turn.finishedAt !== undefined && parts.length > 0) {
    parts.push(formatClockTime(turn.finishedAt));
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** One line per step, for the expanded view of a turn receipt. */
export function formatStepBreakdown(turn: TurnTotals): string {
  return turn.steps
    .map((step, index) => {
      const parts = [`step ${String(index + 1)}`, formatPreciseDuration(step.durationMs)];
      const tokens = tokenPart(step.promptTokens, step.completionTokens);
      if (tokens !== undefined) {
        const rate = stepHitRate(step);
        const cached =
          rate === undefined
            ? ""
            : ` (${String(Math.round(rate * 100))}% cached${
                step.cacheMissReason === undefined
                  ? ""
                  : `, ${describeCacheReason(step.cacheMissReason)}`
              })`;
        parts.push(`${tokens}${cached}`);
      }
      if (step.tokensPerSecond !== undefined && Number.isFinite(step.tokensPerSecond)) {
        parts.push(`${step.tokensPerSecond.toFixed(1)} tok/s`);
      }
      if (step.costUSD !== undefined) {
        parts.push(formatCost(step.costUSD));
      }
      return parts.join(" · ");
    })
    .join("\n");
}
