/**
 * Daily usage tracking (runs, tokens, cost) per calendar day, used for the
 * `/status` report and the optional daily spend cap. `dataDir` is Jazz's home.
 * Storage and aggregation are shared with the Discord bridge via
 * `@jazz/bot-shared/usage-store`; only the store filename is bridge-specific.
 */

import {
  dailyCostCapBlockReason,
  type DailyUsage,
  recordUsage as recordUsageShared,
  todayUsage as todayUsageShared,
} from "@jazz/bot-shared/usage-store";

export type { DailyUsage };
export { dailyCostCapBlockReason };

const USAGE_FILE = "tg-usage.json";

export function todayUsage(dataDir: string): DailyUsage {
  return todayUsageShared(dataDir, USAGE_FILE);
}

export function recordUsage(
  dataDir: string,
  costUSD: number,
  tokens: number,
  costKnown = true,
): void {
  recordUsageShared(dataDir, USAGE_FILE, costUSD, tokens, costKnown);
}
