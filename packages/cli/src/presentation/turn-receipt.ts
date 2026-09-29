/**
 * The totals a whole turn pays for, summed across every model step it took.
 *
 * A turn that calls tools is several model requests; the transcript closes it
 * with one quiet receipt — `12.3s · 4 steps · 65k in → 416 out · $0.08` —
 * rather than a line after every request.
 */

import { formatCompactCount } from "@jazz/core/utils/string";
import { formatCost, formatPreciseDuration } from "../ui/text/format";

export interface StepStats {
  readonly durationMs: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  /** A bare token count, for a provider that reports no prompt/completion split. */
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly costUSD?: number;
  readonly tokensPerSecond?: number;
}

export interface TurnTotals {
  readonly steps: readonly StepStats[];
}

export const EMPTY_TURN: TurnTotals = { steps: [] };

export function addStep(turn: TurnTotals, step: StepStats): TurnTotals {
  return { steps: [...turn.steps, step] };
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

function tokenPart(
  promptTokens: number | undefined,
  completionTokens: number | undefined,
): string | undefined {
  if (promptTokens === undefined && completionTokens === undefined) {
    return undefined;
  }
  return `${formatCompactCount(promptTokens ?? 0)} in → ${formatCompactCount(completionTokens ?? 0)} out`;
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
  const cost = sum(steps, (step) => step.costUSD);
  if (cost !== undefined) {
    parts.push(formatCost(cost));
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
        const cached =
          step.promptTokens !== undefined &&
          step.promptTokens > 0 &&
          (step.cacheReadTokens ?? 0) > 0
            ? ` (${String(Math.round(((step.cacheReadTokens ?? 0) / step.promptTokens) * 100))}% cached)`
            : "";
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
