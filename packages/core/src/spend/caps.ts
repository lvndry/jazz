/**
 * @fileoverview The `daemon` spend caps, checked against the machine-wide spend ledger.
 *
 * Three scopes, all under `daemon` in config.json, all unset (unlimited) by default:
 * - the machine: `dailyCostUSD`, `dailyTokens`, `monthlyCostUSD`, counting every unattended run;
 * - goal work: `goals.dailyCostUSD`, `goals.monthlyCostUSD`, counting goal cycles and loop runs;
 * - one agent: `agents.<id>.dailyCostUSD`, `agents.<id>.monthlyCostUSD`, counting its
 *   unattended runs.
 *
 * Your chat turns never count toward the machine or agent caps. A cap is reached when the
 * spend in its window is at or above it. A dollar cap binds only while every run it counts is
 * priced; one that is not is reported as unenforced, and `dailyTokens` is the cap for a model
 * nobody has priced.
 *
 * {@link evaluateSpendCaps} is the pure rule; {@link checkSpendCaps} reads config and the
 * ledger. The daemon pauses itself at a machine daily cap (`daemon/attention.ts`), and
 * `jazz daemon resume` lifts that for the rest of the day (`capLifted`), which this check
 * honors too.
 */

import { Effect } from "effect";
import type { CostCaps, DaemonConfig } from "@/core/types/config";
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
 * (the chat bridges). The child then neither records its own run nor checks caps, so the run is
 * counted once, against the parent's ledger.
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

export type CapPeriod = "day" | "month";

export type CapMeasure = "cost" | "tokens";

export type CapCheck =
  | { readonly kind: "clear" }
  | {
      readonly kind: "reached";
      readonly scope: SpendScope;
      readonly period: CapPeriod;
      readonly measure: CapMeasure;
      readonly limit: number;
      readonly spent: number;
    };

/** What a run is, for choosing which caps apply to it. */
export interface SpendSubject {
  readonly agentId: string;
  readonly source: SpendSource;
}

export interface CapCheckOptions {
  /** The machine-wide caps are lifted for today (`jazz daemon resume` at a daily cap). */
  readonly machineCapLifted?: boolean;
}

interface CapRule {
  readonly scope: SpendScope;
  readonly period: CapPeriod;
  readonly measure: CapMeasure;
  readonly limit: number;
}

function totalsInScope(day: DaySpend, scope: SpendScope): SpendTotals {
  switch (scope.kind) {
    case "machine":
      return day.unattended;
    case "agent":
      return day.unattendedByAgent[scope.agentId] ?? EMPTY_TOTALS;
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

function costRules(scope: SpendScope, caps: CostCaps | undefined): CapRule[] {
  const rules: CapRule[] = [];
  if (caps?.dailyCostUSD !== undefined) {
    rules.push({ scope, period: "day", measure: "cost", limit: caps.dailyCostUSD });
  }
  if (caps?.monthlyCostUSD !== undefined) {
    rules.push({ scope, period: "month", measure: "cost", limit: caps.monthlyCostUSD });
  }
  return rules;
}

/** Every configured cap, machine first. `subject` narrows it to the caps that cover one run. */
function capRules(config: DaemonConfig | undefined, subject?: SpendSubject): CapRule[] {
  if (config === undefined) {
    return [];
  }
  const machine: SpendScope = { kind: "machine" };
  const rules = costRules(machine, config);
  if (config.dailyTokens !== undefined) {
    rules.push({ scope: machine, period: "day", measure: "tokens", limit: config.dailyTokens });
  }
  if (subject === undefined || isGoalSource(subject.source)) {
    rules.push(...costRules({ kind: "goals" }, config.goals));
  }
  for (const [agentId, caps] of Object.entries(config.agents ?? {})) {
    if (subject === undefined || subject.agentId === agentId) {
      rules.push(...costRules({ kind: "agent", agentId }, caps));
    }
  }
  return rules;
}

/** Whether any cap covers this run (skips reading the ledger when none does). */
export function hasApplicableCap(config: DaemonConfig | undefined, subject: SpendSubject): boolean {
  return capRules(config, subject).length > 0;
}

function spentFor(
  rule: CapRule,
  spend: Pick<SpendReport, "today" | "month">,
): { readonly spent: number; readonly unpricedRuns: number } {
  const totals = totalsInScope(rule.period === "day" ? spend.today : spend.month, rule.scope);
  return rule.measure === "tokens"
    ? { spent: totals.tokens, unpricedRuns: 0 }
    : { spent: totals.costUSD, unpricedRuns: totals.unpricedRuns };
}

/** The first cap covering this run that its window's spend has reached, or clear. */
export function evaluateSpendCaps(
  config: DaemonConfig | undefined,
  spend: Pick<SpendReport, "today" | "month">,
  subject: SpendSubject,
  options: CapCheckOptions = {},
): CapCheck {
  for (const rule of capRules(config, subject)) {
    if (rule.scope.kind === "machine" && options.machineCapLifted === true) {
      continue;
    }
    const { spent, unpricedRuns } = spentFor(rule, spend);
    if (unpricedRuns === 0 && spent >= rule.limit) {
      return { kind: "reached", ...rule, spent };
    }
  }
  return { kind: "clear" };
}

/** Read the ledger and check this run against the configured caps. */
export function checkSpendCaps(
  config: DaemonConfig | undefined,
  subject: SpendSubject,
  options: CapCheckOptions & { readonly now?: number; readonly home?: string } = {},
): Effect.Effect<CapCheck, Error> {
  if (!hasApplicableCap(config, subject)) {
    return Effect.succeed({ kind: "clear" });
  }
  return readSpend(options.now ?? Date.now(), options.home ?? getJazzHomeDirectory()).pipe(
    Effect.map((spend) => evaluateSpendCaps(config, spend, subject, options)),
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

/** The config key that holds a cap, for telling somebody what to change. */
export function capConfigKey(
  scope: SpendScope,
  period: CapPeriod,
  measure: CapMeasure = "cost",
): string {
  const field =
    measure === "tokens" ? "dailyTokens" : period === "day" ? "dailyCostUSD" : "monthlyCostUSD";
  switch (scope.kind) {
    case "machine":
      return `daemon.${field}`;
    case "goals":
      return `daemon.goals.${field}`;
    case "agent":
      return `daemon.agents.${scope.agentId}.${field}`;
  }
}

function formatAmount(measure: CapMeasure, amount: number): string {
  return measure === "cost" ? `$${amount.toFixed(2)}` : `${amount.toLocaleString("en-US")} tokens`;
}

/** One sentence saying which cap blocks and how to lift it. */
export function describeCapCheck(check: Exclude<CapCheck, { kind: "clear" }>): string {
  const key = capConfigKey(check.scope, check.period, check.measure);
  const lift =
    check.scope.kind === "machine" && check.period === "day"
      ? "run `jazz daemon resume` to lift it for today, raise"
      : "raise";
  return `The ${describeScope(check.scope)} ${check.period === "day" ? "daily" : "monthly"} cap (${formatAmount(check.measure, check.limit)}) is reached: ${formatAmount(check.measure, check.spent)} spent by unattended runs. Wait for the next ${check.period}, ${lift} ${key} (jazz config set ${key} <amount>), or clear it.`;
}

/** A run refused because a spend cap covering it is reached. */
export class SpendCapReachedError extends Error {
  override readonly name = "SpendCapReachedError";
  constructor(readonly check: Exclude<CapCheck, { kind: "clear" }>) {
    super(describeCapCheck(check));
  }
}

/** A key that stays the same for one cap over one window, for notifying once per window. */
export function capWindowKey(
  check: Exclude<CapCheck, { kind: "clear" }>,
  spend: Pick<SpendReport, "day" | "monthKey">,
): string {
  const window = check.period === "day" ? spend.day : spend.monthKey;
  return `spend:${capConfigKey(check.scope, check.period, check.measure)}:${window}`;
}

/** One configured cap and where spend stands against it, for `jazz spend` and daemon status. */
export interface CapStatus {
  readonly key: string;
  readonly scope: SpendScope;
  readonly period: CapPeriod;
  readonly measure: CapMeasure;
  readonly limit: number;
  readonly spent: number;
  /** Runs in the window with no price: a dollar cap is not enforced while there are any. */
  readonly unpricedRuns: number;
  readonly reached: boolean;
}

/** Every configured cap, with the spend in its window. */
export function capStatuses(
  config: DaemonConfig | undefined,
  spend: Pick<SpendReport, "today" | "month">,
): readonly CapStatus[] {
  return capRules(config).map((rule) => {
    const { spent, unpricedRuns } = spentFor(rule, spend);
    return {
      key: capConfigKey(rule.scope, rule.period, rule.measure),
      ...rule,
      spent,
      unpricedRuns,
      reached: unpricedRuns === 0 && spent >= rule.limit,
    };
  });
}

/**
 * The machine-wide daily cap today's unattended spend has reached, or undefined: what pauses
 * the daemon until midnight. A dollar cap binds only while every counted run is priced.
 */
export function reachedMachineDailyCap(
  config: DaemonConfig | undefined,
  spend: Pick<SpendReport, "today" | "month">,
): CapMeasure | undefined {
  const reached = capStatuses(config, spend).find(
    (status) => status.scope.kind === "machine" && status.period === "day" && status.reached,
  );
  return reached?.measure;
}

/** Today's unattended spend in the shape the daemon reports it. */
export function unattendedSpend(day: DaySpend): {
  readonly runs: number;
  readonly totalTokens: number;
  readonly costUSD?: number;
  readonly costKnown: boolean;
} {
  const totals = day.unattended;
  const costKnown = totals.unpricedRuns === 0;
  return costKnown
    ? { runs: totals.runs, totalTokens: totals.tokens, costUSD: totals.costUSD, costKnown }
    : { runs: totals.runs, totalTokens: totals.tokens, costKnown };
}
