export interface UsageCostPricing {
  readonly inputPricePerMillion?: number;
  readonly outputPricePerMillion?: number;
  readonly cacheReadPricePerMillion?: number;
}

export interface UsageCostTokens {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens?: number;
}

/**
 * Price a usage sample, billing the cached share of the prompt at the
 * provider's cache-read rate. Providers report cacheReadTokens as a subset of
 * promptTokens, so the uncached share is promptTokens minus cacheReadTokens.
 * Without a cache-read price, cached tokens fall back to the full input rate
 * (an overestimate, but never an understatement of the bill).
 *
 * Returns null when no pricing is known at all.
 */
export function computeUsageCostUSD(
  tokens: UsageCostTokens,
  pricing: UsageCostPricing | undefined,
): number | null {
  if (pricing?.inputPricePerMillion === undefined && pricing?.outputPricePerMillion === undefined) {
    return null;
  }
  const inputPrice = pricing.inputPricePerMillion ?? 0;
  const outputPrice = pricing.outputPricePerMillion ?? 0;
  const cacheReadPrice = pricing.cacheReadPricePerMillion ?? inputPrice;

  const cacheReadTokens = Math.min(tokens.cacheReadTokens ?? 0, tokens.promptTokens);
  const uncachedPromptTokens = tokens.promptTokens - cacheReadTokens;

  return (
    (uncachedPromptTokens / 1_000_000) * inputPrice +
    (cacheReadTokens / 1_000_000) * cacheReadPrice +
    (tokens.completionTokens / 1_000_000) * outputPrice
  );
}
