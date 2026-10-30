import type { GlyphSet } from "@/cli/ui/glyphs";
import { contextPercent, meterFilledCells } from "@/cli/ui/meter";

const METER_CELLS = 24;

/**
 * How fast the bar drains while the summarizer runs. Its real duration is unknown until it
 * ends, so the bar closes half the remaining gap to its floor every period: a quick summary
 * still visibly shrinks the bar, and a slow one never makes it reach the floor and stall.
 */
export const DRAIN_HALF_LIFE_MS = 4_000;

export interface CompactionMeterPlan {
  readonly startPercent: number;
  /** The least the window can hold afterwards: everything compaction keeps without summarizing. */
  readonly floorPercent: number;
}

/**
 * Where the bar starts and the lowest it can drain to, as percents of the window.
 * `retainedTokens` counts what the rebuilt history holds apart from the new summary: the
 * system prompt, pinned messages, any earlier summary, the verbatim tail and the per-request
 * overhead.
 */
export function planCompactionMeter(
  tokensBefore: number,
  retainedTokens: number,
  contextWindow: number,
): CompactionMeterPlan {
  const startPercent = contextPercent(tokensBefore, contextWindow);
  const floorPercent = contextPercent(retainedTokens, contextWindow);
  return { startPercent, floorPercent: Math.min(startPercent, floorPercent) };
}

/**
 * The percent the bar shows `elapsedMs` into the summary. `reclaimedPercent` is what the
 * plugin's pruning pass already freed, which takes the bar down at once before the drain.
 */
export function drainedPercent(
  plan: CompactionMeterPlan,
  elapsedMs: number,
  reclaimedPercent: number,
): number {
  const afterPrune = Math.max(plan.floorPercent, plan.startPercent - reclaimedPercent);
  const remainingGap = (afterPrune - plan.floorPercent) * 0.5 ** (elapsedMs / DRAIN_HALF_LIFE_MS);
  return plan.floorPercent + remainingGap;
}

/**
 * One frame of the meter: the lit run is the heavy rule and the freed run the light one, so
 * the weight alone shows the gauge emptying in any terminal, with or without color.
 */
export function renderCompactionMeter(percent: number, glyphs: GlyphSet): string {
  const rounded = Math.round(percent);
  const filled = meterFilledCells(rounded, METER_CELLS);
  return `${glyphs.ruleHeavy.repeat(filled)}${glyphs.divider.repeat(METER_CELLS - filled)} ${rounded}%`;
}
