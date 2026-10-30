/**
 * Refuseless's `/v1/models` reports context length and reasoning efforts but no price, and
 * models.dev does not list the provider. These are the USD-per-million-token rates from
 * https://refuseless.com/pricing as of 2026-10-26; a model missing here shows no price.
 */
export interface RefuselessPrice {
  readonly inputPricePerMillion: number;
  readonly outputPricePerMillion: number;
}

export const REFUSELESS_PRICES: Readonly<Record<string, RefuselessPrice>> = {
  "glm-5.3-abliterated": { inputPricePerMillion: 1.25, outputPricePerMillion: 2.25 },
  "glm-5.3-flash-abliterated": { inputPricePerMillion: 0.25, outputPricePerMillion: 0.8 },
  "deepseek-v4.1-flash-abliterated": { inputPricePerMillion: 0.22, outputPricePerMillion: 0.75 },
  "deepseek-v4.1-flash-fast": { inputPricePerMillion: 0.05, outputPricePerMillion: 0.15 },
  "minimax-m3.1-flash": { inputPricePerMillion: 0.05, outputPricePerMillion: 0.25 },
};
