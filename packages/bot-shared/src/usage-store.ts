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
 *
 * Every run that reached the model is recorded, failed, timed-out and cancelled ones
 * included: they spent money, and a daily cap that only counted answers would let a
 * failing agent spend without limit. {@link runSpend} decides what a run spent from its
 * envelope, or from the last `run_spend` event when the run left no envelope.
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

/**
 * What to tell someone whose message the cap just blocked.
 *
 * The wording is a product promise about money, and it was written out
 * verbatim in each bridge — so it lives with the rule that produces it rather
 * than being re-typed per surface, where the two would drift.
 */
export function capBlockMessage(reason: "unpriced" | "reached", capUSD: number): string {
  return reason === "unpriced"
    ? "⚠️ Daily cost cap paused: pricing was unavailable for an earlier run today, so spend cannot be verified. Try again tomorrow, disable the cap, or select a priced model."
    : `⚠️ Daily cost cap ($${capUSD.toFixed(2)}) reached. Try again tomorrow, or raise JAZZ_DAILY_COST_CAP_USD.`;
}

/** What one run spent, as the usage store records it. */
export interface RunSpend {
  readonly costUSD: number;
  readonly costKnown: boolean;
  readonly totalTokens: number;
}

/** The spend fields of a `jazz run --json` envelope, success or failure. */
export interface SpendEnvelope {
  readonly ok: boolean;
  readonly costUSD?: number;
  readonly costKnown?: boolean;
  readonly tokenUsage?: { readonly totalTokens?: number };
}

/** A `run_spend` event's fields, as the bridges parse them from `--events spend`. */
export interface RunSpendEvent {
  readonly type: string;
  readonly costUSD?: number;
  readonly costIncomplete?: boolean;
  readonly totalTokens?: number;
}

/** The spend a `run_spend` event reports, or undefined for any other event. */
export function runSpendFromEvent(event: RunSpendEvent): RunSpend | undefined {
  if (event.type !== "run_spend") {
    return undefined;
  }
  return {
    costUSD: event.costUSD ?? 0,
    costKnown: event.costIncomplete !== true && event.costUSD !== undefined,
    totalTokens: event.totalTokens ?? 0,
  };
}

/**
 * What a run spent: the envelope's figure when it carries one (every success, and failures
 * that reached the model), otherwise the last `run_spend` event seen, otherwise nothing.
 */
export function runSpend(
  envelope: SpendEnvelope,
  lastEventSpend: RunSpend | undefined,
): RunSpend | undefined {
  if (envelope.ok || envelope.costKnown !== undefined) {
    return {
      costUSD: envelope.costUSD ?? 0,
      costKnown: envelope.costKnown !== false,
      totalTokens: envelope.tokenUsage?.totalTokens ?? 0,
    };
  }
  return lastEventSpend;
}

/** A run's spend as the fields of a failure envelope, for a run whose own envelope is missing. */
export function spendFields(
  spend: RunSpend | undefined,
): Pick<SpendEnvelope, "costUSD" | "costKnown" | "tokenUsage"> {
  return spend === undefined
    ? {}
    : {
        costUSD: spend.costUSD,
        costKnown: spend.costKnown,
        tokenUsage: { totalTokens: spend.totalTokens },
      };
}

/** Record a run's spend, whatever way it ended; a run that spent nothing knowable is skipped. */
export function recordRunUsage(
  dataDir: string,
  fileName: string,
  spend: RunSpend | undefined,
): void {
  if (spend === undefined) {
    return;
  }
  recordUsage(dataDir, fileName, spend.costUSD, spend.totalTokens, spend.costKnown);
}
