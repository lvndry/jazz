import { describeCacheReason, type CacheObservation } from "@jazz/core/agent/metrics/prompt-cache";
import type { ReportRow } from "@jazz/core/interfaces/terminal";

/**
 * The `/context` rows for prompt-cache behavior: the conversation's latest request's hit rate,
 * or why it is unknown, and what changed in its cacheable prefix versus the request before.
 * A matching prefix does not promise a hit, because providers also expire cached prefixes.
 */
export function cacheContextRows(observation: CacheObservation | undefined): ReportRow[] {
  if (observation === undefined) {
    return [{ kind: "field", key: "cache", value: "no request yet" }];
  }
  const reason = describeCacheReason(observation.change.reason);
  if (observation.hitRate === undefined) {
    return [
      {
        kind: "field",
        key: "cache",
        value: "unknown",
        detail: `no cache figure from the provider; ${reason}`,
      },
    ];
  }
  return [
    {
      kind: "field",
      key: "cache",
      value: `${String(Math.round(observation.hitRate * 100))}% hit`,
      detail: `last request: ${reason}`,
    },
  ];
}
