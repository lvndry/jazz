/**
 * Daily usage (runs, tokens, cost) per bridge, for the `/status` report and the optional daily
 * spend cap (`JAZZ_DAILY_COST_CAP_USD`), shared by every chat bridge.
 *
 * The numbers live in the machine-wide spend ledger under the bridge's `JAZZ_HOME`
 * (`@jazz/core/spend/ledger`), the same ledger `jazz spend` reads, so a bridge's spend and the
 * rest of the machine's are one source of truth. Each bridge records under its own origin
 * ("telegram", "discord", ...), and its cap counts only that origin. The cost itself comes
 * pre-computed from `jazz run --json`'s `costUSD`; the child run is told not to record itself
 * (see `bridgeRunEnv`), so nothing is counted twice.
 */

import { recordSpend, readSpend } from "@jazz/core/spend/ledger";
import { Effect } from "effect";

export interface DailyUsage {
  readonly costUSD: number;
  readonly tokens: number;
  readonly runs: number;
  readonly unpricedRuns?: number;
}

/** What one bridge run spent, as its envelope reports it. */
export interface BridgeRunUsage {
  readonly agentId: string;
  readonly costUSD: number;
  readonly tokens: number;
  readonly costKnown: boolean;
}

/** This bridge's spend today, in the machine's local calendar. */
export async function todayUsage(jazzHome: string, origin: string): Promise<DailyUsage> {
  const spend = await Effect.runPromise(readSpend(Date.now(), jazzHome));
  const totals = spend.today.byOrigin[origin];
  return totals === undefined
    ? { costUSD: 0, tokens: 0, runs: 0 }
    : {
        costUSD: totals.costUSD,
        tokens: totals.tokens,
        runs: totals.runs,
        unpricedRuns: totals.unpricedRuns,
      };
}

export function dailyCostCapBlockReason(
  usage: DailyUsage,
  capUSD: number,
): "unpriced" | "reached" | undefined {
  if (capUSD <= 0) return undefined;
  if ((usage.unpricedRuns ?? 0) > 0) return "unpriced";
  return usage.costUSD >= capUSD ? "reached" : undefined;
}

/** Record one bridge run in the ledger. A write failure is logged, never thrown at the chat. */
export async function recordUsage(
  jazzHome: string,
  origin: string,
  usage: BridgeRunUsage,
): Promise<void> {
  await Effect.runPromise(
    recordSpend(
      {
        agentId: usage.agentId,
        source: "bot",
        origin,
        costUSD: usage.costUSD,
        costKnown: usage.costKnown,
        tokens: usage.tokens,
      },
      jazzHome,
    ).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => console.error(`Could not record run usage: ${error.message}`)),
      ),
    ),
  );
}

/**
 * What to tell someone whose message the cap just blocked.
 *
 * The wording is a product promise about money, and it was written out
 * verbatim in each bridge, so it lives with the rule that produces it rather
 * than being re-typed per surface, where the two would drift.
 */
export function capBlockMessage(reason: "unpriced" | "reached", capUSD: number): string {
  return reason === "unpriced"
    ? "⚠️ Daily cost cap paused: pricing was unavailable for an earlier run today, so spend cannot be verified. Try again tomorrow, disable the cap, or select a priced model."
    : `⚠️ Daily cost cap ($${capUSD.toFixed(2)}) reached. Try again tomorrow, or raise JAZZ_DAILY_COST_CAP_USD.`;
}
