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
 * Every run that reached the model is recorded, failed, timed-out and cancelled ones
 * included: they spent money, and a daily cap that only counted answers would let a
 * failing agent spend without limit. {@link runSpend} decides what a run spent from its
 * envelope, or from the last `run_spend` event when the run left no envelope.
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
        unattended: false,
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
export async function recordRunUsage(
  dataDir: string,
  origin: string,
  agentId: string,
  spend: RunSpend | undefined,
): Promise<void> {
  if (spend === undefined) {
    return;
  }
  await recordUsage(dataDir, origin, {
    agentId,
    costUSD: spend.costUSD,
    tokens: spend.totalTokens,
    costKnown: spend.costKnown,
  });
}
