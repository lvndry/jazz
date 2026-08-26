/** Validates and resolves user-configured context warn/compact ratios against the defaults. */

import type { ContextConfig } from "@/core/types/config";
import {
  CONTEXT_COMPACT_THRESHOLD_RATIO,
  CONTEXT_TRIM_THRESHOLD_RATIO,
  CONTEXT_WARN_THRESHOLD_RATIO,
} from "./context-window-manager";

export interface ResolvedContextThresholds {
  readonly warnThresholdRatio: number;
  readonly compactThresholdRatio: number;
  /** Reasons any configured value was rejected, for the caller to log. */
  readonly warnings: readonly string[];
}

function isUsableRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
}

/**
 * Resolve the warn and compaction thresholds from app config.
 *
 * Each configured value is taken only if it holds the ordering the design depends on:
 * warn < compact < trim. A compaction threshold at or above the trim ratio would let
 * trimming pre-empt compaction, turning the whole scheme into a sliding window that
 * discards history instead of summarizing it, and a warn threshold at or above the
 * compaction one would never fire before the compaction it is meant to pre-announce.
 * Rejected values fall back to the defaults rather than failing the run.
 */
export function resolveContextThresholds(
  context: ContextConfig | undefined,
): ResolvedContextThresholds {
  const warnings: string[] = [];

  let compactThresholdRatio = CONTEXT_COMPACT_THRESHOLD_RATIO;
  const configuredCompact = context?.compactThresholdRatio;
  if (configuredCompact !== undefined && configuredCompact !== null) {
    if (!isUsableRatio(configuredCompact)) {
      warnings.push(
        `Ignoring context.compactThresholdRatio "${String(configuredCompact)}" — expected a number between 0 and 1. Using ${CONTEXT_COMPACT_THRESHOLD_RATIO}.`,
      );
    } else if (configuredCompact >= CONTEXT_TRIM_THRESHOLD_RATIO) {
      warnings.push(
        `Ignoring context.compactThresholdRatio ${configuredCompact} — it must stay below the trim ratio ${CONTEXT_TRIM_THRESHOLD_RATIO}, or history is discarded instead of summarized. Using ${CONTEXT_COMPACT_THRESHOLD_RATIO}.`,
      );
    } else {
      compactThresholdRatio = configuredCompact;
    }
  }

  let warnThresholdRatio = Math.min(CONTEXT_WARN_THRESHOLD_RATIO, compactThresholdRatio);
  const configuredWarn = context?.warnThresholdRatio;
  if (configuredWarn !== undefined && configuredWarn !== null) {
    if (!isUsableRatio(configuredWarn)) {
      warnings.push(
        `Ignoring context.warnThresholdRatio "${String(configuredWarn)}" — expected a number between 0 and 1. Using ${warnThresholdRatio}.`,
      );
    } else if (configuredWarn >= compactThresholdRatio) {
      warnings.push(
        `Ignoring context.warnThresholdRatio ${configuredWarn} — it must stay below the compaction ratio ${compactThresholdRatio}, or the warning never precedes compaction. Using ${warnThresholdRatio}.`,
      );
    } else {
      warnThresholdRatio = configuredWarn;
    }
  }

  return { warnThresholdRatio, compactThresholdRatio, warnings };
}
