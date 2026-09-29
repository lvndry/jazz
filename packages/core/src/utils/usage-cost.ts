/**
 * Prices a model call's token usage from per-million-token rates, and says when a price is only
 * a lower bound because the rates for part of the usage are unknown.
 */

export interface UsageCostPricing {
  readonly inputPricePerMillion?: number;
  readonly outputPricePerMillion?: number;
  readonly cacheReadPricePerMillion?: number;
  readonly cacheWritePricePerMillion?: number;
}

export interface UsageCostTokens {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** Authoritative per-call charge returned by the provider, when available. */
  readonly billedCostUSD?: number;
}

/**
 * Price a usage sample. Providers report cache reads and cache writes as parts of
 * promptTokens, so the uncached share is what remains. Cache reads without a cache-read price
 * fall back to the full input rate (an overestimate). Cache writes without a cache-write price
 * fall back to the input rate too, which understates providers that charge a premium for them
 * (Anthropic bills 1.25x); {@link isUsageCostIncomplete} reports that case so the figure is not
 * passed off as exact. An authoritative `billedCostUSD` on the usage sample takes precedence over
 * these token-rate estimates.
 *
 * Returns null when no pricing is known at all.
 */
export function computeUsageCostUSD(
  tokens: UsageCostTokens,
  pricing: UsageCostPricing | undefined,
): number | null {
  if (tokens.billedCostUSD !== undefined) return tokens.billedCostUSD;
  if (pricing?.inputPricePerMillion === undefined && pricing?.outputPricePerMillion === undefined) {
    return null;
  }
  const inputPrice = pricing.inputPricePerMillion ?? 0;
  const outputPrice = pricing.outputPricePerMillion ?? 0;
  const cacheReadPrice = pricing.cacheReadPricePerMillion ?? inputPrice;
  const cacheWritePrice = pricing.cacheWritePricePerMillion ?? inputPrice;

  const cacheReadTokens = Math.min(tokens.cacheReadTokens ?? 0, tokens.promptTokens);
  const cacheWriteTokens = Math.min(
    tokens.cacheWriteTokens ?? 0,
    tokens.promptTokens - cacheReadTokens,
  );
  const uncachedPromptTokens = tokens.promptTokens - cacheReadTokens - cacheWriteTokens;

  return (
    (uncachedPromptTokens / 1_000_000) * inputPrice +
    (cacheReadTokens / 1_000_000) * cacheReadPrice +
    (cacheWriteTokens / 1_000_000) * cacheWritePrice +
    (tokens.completionTokens / 1_000_000) * outputPrice
  );
}

/**
 * Whether a computed price understates the bill: the usage wrote to the prompt cache and the
 * pricing has no cache-write rate, so those tokens were priced at the plain input rate.
 */
export function isUsageCostIncomplete(
  tokens: UsageCostTokens,
  pricing: UsageCostPricing | undefined,
): boolean {
  if (tokens.billedCostUSD !== undefined) return false;
  return (
    (tokens.cacheWriteTokens ?? 0) > 0 &&
    pricing?.cacheWritePricePerMillion === undefined &&
    (pricing?.inputPricePerMillion !== undefined || pricing?.outputPricePerMillion !== undefined)
  );
}
