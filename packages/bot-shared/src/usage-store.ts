/**
 * Daily usage tracking (runs, tokens, cost) per calendar day, shared by the
 * Discord and Telegram bridges — used for the `/status` report and the
 * optional daily spend cap.
 *
 * The cost figure itself comes pre-computed from `jazz run --json`'s
 * `costUSD` (see `@jazz/core/utils/usage-cost`); this module only persists
 * and aggregates what each run reports.
 *
 * `fileName` is the per-bridge store file (`dc-usage.json`/`tg-usage.json`);
 * each bridge's own `usage.ts` bakes that in so call sites don't repeat it.
 */

import { readRecordStore, recordStorePath, writeRecordStore } from "./scoped-record-store";

export interface DailyUsage {
  costUSD: number;
  tokens: number;
  runs: number;
  unpricedRuns?: number;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function todayUsage(dataDir: string, fileName: string): DailyUsage {
  const usage = readRecordStore<DailyUsage>(recordStorePath(dataDir, fileName)) ?? {};
  return usage[todayKey()] ?? { costUSD: 0, tokens: 0, runs: 0 };
}

export function dailyCostCapBlockReason(
  usage: DailyUsage,
  capUSD: number,
): "unpriced" | "reached" | undefined {
  if (capUSD <= 0) return undefined;
  if ((usage.unpricedRuns ?? 0) > 0) return "unpriced";
  return usage.costUSD >= capUSD ? "reached" : undefined;
}

export function recordUsage(
  dataDir: string,
  fileName: string,
  costUSD: number,
  tokens: number,
  costKnown = true,
): void {
  const path = recordStorePath(dataDir, fileName);
  const usage = readRecordStore<DailyUsage>(path) ?? {};
  const key = todayKey();
  const day = usage[key] ?? { costUSD: 0, tokens: 0, runs: 0 };
  usage[key] = {
    costUSD: day.costUSD + costUSD,
    tokens: day.tokens + tokens,
    runs: day.runs + 1,
    unpricedRuns: (day.unpricedRuns ?? 0) + (costKnown ? 0 : 1),
  };
  // Keep the file bounded — drop entries older than 30 days.
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  for (const date of Object.keys(usage)) {
    if (date < cutoff) delete usage[date];
  }
  writeRecordStore(path, usage);
}
