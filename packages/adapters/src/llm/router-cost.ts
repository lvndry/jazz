/**
 * Normalize provider-reported per-call costs from router response metadata. OpenRouter, OrcaRouter,
 * and Vercel AI Gateway each expose the charge under a different response shape; this module keeps
 * that provider-specific parsing out of both the streaming and non-streaming LLM paths.
 */

import { isRecord } from "@jazz/core/utils/is-record";

/** Read a non-negative USD charge from a router's AI SDK provider metadata. */
export function routerBilledCostUSD(provider: string, metadata: unknown): number | undefined {
  if (!isRecord(metadata)) return undefined;

  switch (provider) {
    case "ai_gateway": {
      const gatewayMetadata = metadata["gateway"];
      return isRecord(gatewayMetadata) ? finiteCostUSD(gatewayMetadata["cost"]) : undefined;
    }
    case "openrouter": {
      const openRouterMetadata = metadata["openrouter"];
      if (!isRecord(openRouterMetadata) || !isRecord(openRouterMetadata["usage"])) {
        return undefined;
      }
      return finiteCostUSD(openRouterMetadata["usage"]["cost"]);
    }
    case "orcarouter": {
      const orcaRouterMetadata = metadata["orcarouter"];
      return isRecord(orcaRouterMetadata)
        ? finiteCostUSD(orcaRouterMetadata["billedCostUSD"])
        : undefined;
    }
    default:
      return undefined;
  }
}

/** Read OrcaRouter's optional `usage.cost_usd` from a parsed response or streaming chunk. */
export function orcaRouterResponseCostUSD(response: unknown): number | undefined {
  if (!isRecord(response) || !isRecord(response["usage"])) return undefined;
  return finiteCostUSD(response["usage"]["cost_usd"]);
}

function finiteCostUSD(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
