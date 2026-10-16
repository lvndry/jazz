export interface ContextUsageStats {
  readonly currentTokens: number;
  readonly maxTokens: number;
  readonly warnThresholdRatio: number;
  readonly compactThresholdRatio: number;
}

export interface ContextUsageReport {
  readonly estimatedTokensUsed: number;
  readonly maxTokens: number;
  readonly remainingTokens: number;
  readonly percentUsed: number;
  readonly compactsAtPercent: number;
  readonly recommendation: string;
}

/**
 * What `context_info` reports, and what the model is shown after every compaction.
 * The recommendation tiers follow the run's own warn and compaction thresholds, so the
 * report never disagrees with the pressure nudges or with when compaction actually fires.
 */
export function describeContextUsage(stats: ContextUsageStats): ContextUsageReport {
  const { currentTokens, maxTokens, warnThresholdRatio, compactThresholdRatio } = stats;
  const usedRatio = currentTokens / maxTokens;
  const compactsAtPercent = Math.round(compactThresholdRatio * 100);

  let recommendation: string;
  if (usedRatio < warnThresholdRatio) {
    recommendation = "Context budget is healthy. Proceed normally.";
  } else if (usedRatio < compactThresholdRatio) {
    recommendation = `Older history is summarized automatically at ${String(compactsAtPercent)}%, and detail is lost when that happens. Record findings you need to keep and prefer consolidating over gathering more.`;
  } else {
    recommendation =
      "Past the compaction point: older history is summarized before the next request. Prefer finishing current work over opening new investigations.";
  }

  return {
    estimatedTokensUsed: currentTokens,
    maxTokens,
    remainingTokens: maxTokens - currentTokens,
    percentUsed: Math.round(usedRatio * 100),
    compactsAtPercent,
    recommendation,
  };
}

export function formatContextUsageReport(report: ContextUsageReport): string {
  return [
    `estimatedTokensUsed: ${String(report.estimatedTokensUsed)}`,
    `maxTokens: ${String(report.maxTokens)}`,
    `remainingTokens: ${String(report.remainingTokens)}`,
    `percentUsed: ${String(report.percentUsed)}%`,
    `compactsAtPercent: ${String(report.compactsAtPercent)}%`,
    `recommendation: ${report.recommendation}`,
  ].join("\n");
}
