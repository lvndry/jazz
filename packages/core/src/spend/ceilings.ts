/**
 * @fileoverview Day and month spend ceilings, checked against the machine-wide ledger.
 *
 * Three scopes can each carry a day and a month ceiling (`spend` in config.json): every run on
 * this machine, one agent (`spend.agents.<id>`), and goal work (`spend.goals`, which covers
 * goal cycles and loop runs). All are unset, meaning unlimited, by default.
 *
 * A ceiling is reached when the spend in its window is at or above it. A day ceiling also
 * counts as reached when a run in that scope today had no pricing: its dollars are unknown, so
 * the ceiling cannot be verified, and the honest answer is to stop rather than to keep
 * spending blind. A month ceiling counts priced spend and reports unpriced runs alongside.
 *
 * {@link evaluateSpendCeilings} is the pure rule; {@link checkSpendCeilings} reads config and
 * the ledger. Unattended entry points refuse a run when the check is not clear (see
 * `isUnattendedSource`); chat warns and proceeds.
 */

import { Effect } from "effect";
import type { SpendConfig, SpendLimits } from "@/core/types/spend";
import { getJazzHomeDirectory } from "@/core/utils/paths";
import {
  EMPTY_TOTALS,
  readSpend,
  type DaySpend,
  type SpendReport,
  type SpendTotals,
} from "./ledger";
import { isGoalSource, type SpendSource } from "./sources";

/**
 * Set by a process that records a child `jazz run`'s cost itself, from the child's envelope
 * (the chat bridges). The child then neither records its own run nor checks ceilings, so the
 * run is counted once, against the parent's ledger.
 */
export const SPEND_LEDGER_ENV = "JAZZ_SPEND_LEDGER";

/** The {@link SPEND_LEDGER_ENV} value meaning "the process that started me records this run". */
export const SPEND_RECORDED_BY_PARENT = "parent";

/** Whether this process's runs are recorded by the process that started it. */
export function isSpendRecordedByParent(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SPEND_LEDGER_ENV] === SPEND_RECORDED_BY_PARENT;
}

export type SpendScope =
  | { readonly kind: "machine" }
  | { readonly kind: "goals" }
  | { readonly kind: "agent"; readonly agentId: string };

export type SpendPeriod = "day" | "month";

export type CeilingCheck =
  | { readonly kind: "clear" }
  | {
      readonly kind: "reached";
      readonly scope: SpendScope;
      readonly period: SpendPeriod;
      readonly limitUSD: number;
      readonly spentUSD: number;
    }
  | {
      readonly kind: "unverifiable";
      readonly scope: SpendScope;
      readonly period: SpendPeriod;
      readonly limitUSD: number;
      readonly unpricedRuns: number;
    };

/** What a run is, for choosing which ceilings apply to it. */
export interface SpendSubject {
  readonly agentId: string;
  readonly source: SpendSource;
}

function totalsInScope(day: DaySpend, scope: SpendScope): SpendTotals {
  switch (scope.kind) {
    case "machine":
      return day.total;
    case "agent":
      return day.byAgent[scope.agentId] ?? EMPTY_TOTALS;
    case "goals": {
      const goal = day.bySource.goal ?? EMPTY_TOTALS;
      const loop = day.bySource.loop ?? EMPTY_TOTALS;
      return {
        costUSD: goal.costUSD + loop.costUSD,
        runs: goal.runs + loop.runs,
        tokens: goal.tokens + loop.tokens,
        unpricedRuns: goal.unpricedRuns + loop.unpricedRuns,
      };
    }
  }
}

function scopesFor(
  config: SpendConfig | undefined,
  subject: SpendSubject,
): ReadonlyArray<{ readonly scope: SpendScope; readonly limits: SpendLimits }> {
  if (config === undefined) {
    return [];
  }
  const scopes: Array<{ scope: SpendScope; limits: SpendLimits }> = [
    { scope: { kind: "machine" }, limits: config },
  ];
  const agentLimits = config.agents?.[subject.agentId];
  if (agentLimits !== undefined) {
    scopes.push({ scope: { kind: "agent", agentId: subject.agentId }, limits: agentLimits });
  }
  if (config.goals !== undefined && isGoalSource(subject.source)) {
    scopes.push({ scope: { kind: "goals" }, limits: config.goals });
  }
  return scopes;
}

/** Whether any ceiling at all applies to this run (skips reading the ledger when none does). */
export function hasApplicableCeiling(
  config: SpendConfig | undefined,
  subject: SpendSubject,
): boolean {
  return scopesFor(config, subject).some(
    ({ limits }) => limits.dayUSD !== undefined || limits.monthUSD !== undefined,
  );
}

/**
 * The first ceiling that blocks this run, or clear. A reached ceiling is reported before an
 * unverifiable one, since it is the firmer reason.
 */
export function evaluateSpendCeilings(
  config: SpendConfig | undefined,
  spend: Pick<SpendReport, "today" | "month">,
  subject: SpendSubject,
): CeilingCheck {
  let unverifiable: CeilingCheck | undefined;
  for (const { scope, limits } of scopesFor(config, subject)) {
    const windows: ReadonlyArray<readonly [SpendPeriod, number | undefined, DaySpend]> = [
      ["day", limits.dayUSD, spend.today],
      ["month", limits.monthUSD, spend.month],
    ];
    for (const [period, limitUSD, window] of windows) {
      if (limitUSD === undefined) {
        continue;
      }
      const totals = totalsInScope(window, scope);
      if (totals.costUSD >= limitUSD) {
        return { kind: "reached", scope, period, limitUSD, spentUSD: totals.costUSD };
      }
      if (period === "day" && totals.unpricedRuns > 0 && unverifiable === undefined) {
        unverifiable = {
          kind: "unverifiable",
          scope,
          period,
          limitUSD,
          unpricedRuns: totals.unpricedRuns,
        };
      }
    }
  }
  return unverifiable ?? { kind: "clear" };
}

/** Read the ledger and check this run against the configured ceilings. */
export function checkSpendCeilings(
  config: SpendConfig | undefined,
  subject: SpendSubject,
  now: number = Date.now(),
  home: string = getJazzHomeDirectory(),
): Effect.Effect<CeilingCheck, Error> {
  if (!hasApplicableCeiling(config, subject)) {
    return Effect.succeed({ kind: "clear" });
  }
  return readSpend(now, home).pipe(
    Effect.map((spend) => evaluateSpendCeilings(config, spend, subject)),
  );
}

function describeScope(scope: SpendScope): string {
  switch (scope.kind) {
    case "machine":
      return "machine-wide";
    case "goals":
      return "goals";
    case "agent":
      return `agent "${scope.agentId}"`;
  }
}

/** The config key that holds a ceiling, for telling somebody what to change. */
export function ceilingConfigKey(scope: SpendScope, period: SpendPeriod): string {
  const field = period === "day" ? "dayUSD" : "monthUSD";
  switch (scope.kind) {
    case "machine":
      return `spend.${field}`;
    case "goals":
      return `spend.goals.${field}`;
    case "agent":
      return `spend.agents.${scope.agentId}.${field}`;
  }
}

function formatUSD(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** One sentence saying which ceiling blocks and how to lift it. */
export function describeCeilingCheck(check: Exclude<CeilingCheck, { kind: "clear" }>): string {
  const which = `The ${describeScope(check.scope)} ${check.period === "day" ? "daily" : "monthly"} spend ceiling (${formatUSD(check.limitUSD)})`;
  const key = ceilingConfigKey(check.scope, check.period);
  if (check.kind === "reached") {
    return `${which} is reached: ${formatUSD(check.spentUSD)} spent. Raise or clear ${key} (jazz config set ${key} <dollars>), or wait for the next ${check.period}.`;
  }
  return `${which} cannot be verified: ${check.unpricedRuns} run${check.unpricedRuns === 1 ? "" : "s"} today had no pricing, so their cost is unknown. Use a priced model, clear ${key}, or wait for tomorrow.`;
}

/** A run refused because a spend ceiling blocks it. */
export class SpendCeilingReachedError extends Error {
  override readonly name = "SpendCeilingReachedError";
  constructor(readonly check: Exclude<CeilingCheck, { kind: "clear" }>) {
    super(describeCeilingCheck(check));
  }
}

/** A key that stays the same for one ceiling over one window, for notifying once per window. */
export function ceilingWindowKey(
  check: Exclude<CeilingCheck, { kind: "clear" }>,
  spend: Pick<SpendReport, "day" | "monthKey">,
): string {
  const window = check.period === "day" ? spend.day : spend.monthKey;
  return `spend:${ceilingConfigKey(check.scope, check.period)}:${check.kind}:${window}`;
}

/** One configured ceiling and where spend stands against it, for `jazz spend`. */
export interface CeilingStatus {
  readonly key: string;
  readonly scope: SpendScope;
  readonly period: SpendPeriod;
  readonly limitUSD: number;
  readonly spentUSD: number;
  readonly unpricedRuns: number;
  readonly reached: boolean;
}

/** Every configured ceiling, with the spend in its window. */
export function ceilingStatuses(
  config: SpendConfig | undefined,
  spend: Pick<SpendReport, "today" | "month">,
): readonly CeilingStatus[] {
  if (config === undefined) {
    return [];
  }
  type ScopedLimits = { readonly scope: SpendScope; readonly limits: SpendLimits };
  const scoped: ScopedLimits[] = [{ scope: { kind: "machine" }, limits: config }];
  if (config.goals !== undefined) {
    scoped.push({ scope: { kind: "goals" }, limits: config.goals });
  }
  for (const [agentId, limits] of Object.entries(config.agents ?? {})) {
    scoped.push({ scope: { kind: "agent", agentId }, limits });
  }
  const statuses: CeilingStatus[] = [];
  for (const { scope, limits } of scoped) {
    for (const [period, limitUSD, window] of [
      ["day", limits.dayUSD, spend.today],
      ["month", limits.monthUSD, spend.month],
    ] as const) {
      if (limitUSD === undefined) {
        continue;
      }
      const totals = totalsInScope(window, scope);
      statuses.push({
        key: ceilingConfigKey(scope, period),
        scope,
        period,
        limitUSD,
        spentUSD: totals.costUSD,
        unpricedRuns: totals.unpricedRuns,
        reached: totals.costUSD >= limitUSD || (period === "day" && totals.unpricedRuns > 0),
      });
    }
  }
  return statuses;
}
