/**
 * @fileoverview The `daemon` spend caps, checked against the machine-wide spend ledger.
 *
 * Three scopes, all under `daemon` in config.json, all unset (unlimited) by default:
 * - the machine: `dailyCostUSD`, `dailyTokens`, `monthlyCostUSD`, counting every unattended run;
 * - goal work: `goals.dailyCostUSD`, `goals.monthlyCostUSD`, counting goal cycles and loop runs;
 * - one agent: `agents.<agent>.dailyCostUSD`, `agents.<agent>.monthlyCostUSD`, counting its
 *   unattended runs. The key is the agent's name or its id.
 *
 * Your chat turns never count toward the machine or agent caps. A cap is reached when the
 * priced spend in its window is at or above it: unpriced runs only add to that, so priced spend
 * is a lower bound. A daily dollar cap with an unpriced run in its window today cannot be
 * verified and blocks like a reached one; a monthly one counts priced spend and reports the
 * unpriced runs alongside. `dailyTokens` is the cap for a model nobody has priced.
 *
 * {@link evaluateSpendCaps} is the pure rule; {@link checkSpendCaps} reads config and the
 * ledger, and {@link checkAndReserveSpendCaps} also holds an in-flight reservation for a run
 * that passes, so runs starting together cannot all spend the same headroom. The daemon pauses
 * itself at a machine daily cap (`packages/daemon/src/attention.ts`), and `jazz daemon resume` lifts the
 * machine daily caps for the rest of the day (`capLifted`), which this check honors too.
 */

import { Effect, Option } from "effect";
import { AgentServiceTag } from "@/core/interfaces/agent-service";
import type { CostCaps, DaemonConfig } from "@/core/types/config";
import { getJazzHomeDirectory } from "@/core/utils/paths";
import {
  checkAndReserveSpend,
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
  | {
      readonly kind: "agent";
      /** The key under `daemon.agents`: the agent's name or id. */
      readonly key: string;
      /** The agent the key resolves to, whose ledger spend is counted. */
      readonly agentId: string;
    };

export type CapPeriod = "day" | "month";

export type CapMeasure = "cost" | "tokens";

/** A cap that blocks: its spend reached it, or (a daily dollar cap) unpriced runs hide it. */
export interface BlockingCap {
  readonly kind: "reached" | "unverifiable";
  readonly scope: SpendScope;
  readonly period: CapPeriod;
  readonly measure: CapMeasure;
  readonly limit: number;
  /** Priced spend in the window. */
  readonly spent: number;
  /** Runs in the window with no price, whose dollars are missing from `spent`. */
  readonly unpricedRuns: number;
}

export type CapCheck = { readonly kind: "clear" } | BlockingCap;

/** What a run is, for choosing which caps apply to it. */
export interface SpendSubject {
  readonly agentId: string;
  /** Matched against `daemon.agents` keys as well as the id. */
  readonly agentName?: string;
  readonly source: SpendSource;
}

/** An agent as the caps resolve `daemon.agents` keys against it. */
export interface CapAgent {
  readonly id: string;
  readonly name: string;
}

export interface CapCheckOptions {
  /** The machine-wide daily caps are lifted for today (`jazz daemon resume`). */
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

/** The agent a `daemon.agents` key names: an agent id first, then an agent name. */
export function resolveCapAgentKey(key: string, agents: readonly CapAgent[]): CapAgent | undefined {
  return agents.find((agent) => agent.id === key) ?? agents.find((agent) => agent.name === key);
}

/** The agents in context, for resolving `daemon.agents` keys; none when there is no agent service. */
export function listCapAgents(): Effect.Effect<readonly CapAgent[]> {
  return Effect.serviceOption(AgentServiceTag).pipe(
    Effect.flatMap((service) =>
      Option.isNone(service)
        ? Effect.succeed<readonly CapAgent[]>([])
        : service.value.listAgents().pipe(
            Effect.map((agents) => agents.map((agent) => ({ id: agent.id, name: agent.name }))),
            Effect.catchAll(() => Effect.succeed<readonly CapAgent[]>([])),
          ),
    ),
  );
}

/** The `daemon.agents` keys that name no agent in `agents`, so their caps bind nothing. */
export function unknownAgentCapKeys(
  config: DaemonConfig | undefined,
  agents: readonly CapAgent[],
): readonly string[] {
  return Object.keys(config?.agents ?? {}).filter(
    (key) => resolveCapAgentKey(key, agents) === undefined,
  );
}

/**
 * Every configured cap, machine first. `subject` narrows it to the caps that cover one run;
 * without one, agent keys resolve through `agents` (a key naming no agent is read as an id).
 */
function capRules(
  config: DaemonConfig | undefined,
  subject?: SpendSubject,
  agents: readonly CapAgent[] = [],
): CapRule[] {
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
  for (const [key, caps] of Object.entries(config.agents ?? {})) {
    if (subject === undefined) {
      const agentId = resolveCapAgentKey(key, agents)?.id ?? key;
      rules.push(...costRules({ kind: "agent", key, agentId }, caps));
    } else if (key === subject.agentId || key === subject.agentName) {
      rules.push(...costRules({ kind: "agent", key, agentId: subject.agentId }, caps));
    }
  }
  return rules;
}

/** Whether a machine-wide daily cap (`daemon.dailyCostUSD`, `daemon.dailyTokens`) is set. */
export function hasMachineDailyCap(config: DaemonConfig | undefined): boolean {
  return capRules(config).some((rule) => rule.scope.kind === "machine" && rule.period === "day");
}

function hasApplicableCap(config: DaemonConfig | undefined, subject: SpendSubject): boolean {
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

/** Where one rule stands: reached, unverifiable (a daily dollar cap with unpriced runs), or under. */
function ruleState(
  rule: CapRule,
  spent: number,
  unpricedRuns: number,
): "reached" | "unverifiable" | "under" {
  if (spent >= rule.limit) {
    return "reached";
  }
  if (rule.period === "day" && rule.measure === "cost" && unpricedRuns > 0) {
    return "unverifiable";
  }
  return "under";
}

function isLiftedBy(rule: CapRule, options: CapCheckOptions): boolean {
  return (
    options.machineCapLifted === true && rule.scope.kind === "machine" && rule.period === "day"
  );
}

/**
 * The first cap covering this run that blocks it, or clear. A reached cap is reported before an
 * unverifiable one, since it is the firmer reason.
 */
export function evaluateSpendCaps(
  config: DaemonConfig | undefined,
  spend: Pick<SpendReport, "today" | "month">,
  subject: SpendSubject,
  options: CapCheckOptions = {},
): CapCheck {
  let unverifiable: BlockingCap | undefined;
  for (const rule of capRules(config, subject)) {
    if (isLiftedBy(rule, options)) {
      continue;
    }
    const { spent, unpricedRuns } = spentFor(rule, spend);
    const state = ruleState(rule, spent, unpricedRuns);
    if (state === "reached") {
      return { kind: "reached", ...rule, spent, unpricedRuns };
    }
    if (state === "unverifiable" && unverifiable === undefined) {
      unverifiable = { kind: "unverifiable", ...rule, spent, unpricedRuns };
    }
  }
  return unverifiable ?? { kind: "clear" };
}

type CheckOptions = CapCheckOptions & { readonly now?: number; readonly home?: string };

/** Read the ledger and check this run against the configured caps. */
export function checkSpendCaps(
  config: DaemonConfig | undefined,
  subject: SpendSubject,
  options: CheckOptions = {},
): Effect.Effect<CapCheck, Error> {
  if (!hasApplicableCap(config, subject)) {
    return Effect.succeed({ kind: "clear" });
  }
  return readSpend(options.now ?? Date.now(), options.home ?? getJazzHomeDirectory()).pipe(
    Effect.map((spend) => evaluateSpendCaps(config, spend, subject, options)),
  );
}

/**
 * What one more unattended run is expected to spend: the average of this month's unattended
 * runs, dollars over the priced ones and tokens over all. Zero before any has finished.
 */
export function estimatedRunSpend(month: DaySpend): {
  readonly costUSD: number;
  readonly tokens: number;
} {
  const totals = month.unattended;
  const pricedRuns = totals.runs - totals.unpricedRuns;
  return {
    costUSD: pricedRuns > 0 ? totals.costUSD / pricedRuns : 0,
    tokens: totals.runs > 0 ? totals.tokens / totals.runs : 0,
  };
}

/**
 * Check an unattended run against the caps, counting the runs still in flight at their
 * estimated cost, and, when it is clear, hold an in-flight reservation `reservationId` for it at
 * {@link estimatedRunSpend} until `releaseInFlightSpend`. With no cap covering the run nothing is
 * read or reserved.
 */
export function checkAndReserveSpendCaps(
  config: DaemonConfig | undefined,
  subject: SpendSubject,
  reservationId: string,
  options: CheckOptions = {},
): Effect.Effect<CapCheck, Error> {
  if (!hasApplicableCap(config, subject)) {
    return Effect.succeed({ kind: "clear" });
  }
  return checkAndReserveSpend<CapCheck>(
    (spend) => {
      const check = evaluateSpendCaps(config, spend, subject, options);
      return check.kind === "clear"
        ? {
            outcome: check,
            reservation: {
              id: reservationId,
              agentId: subject.agentId,
              source: subject.source,
              ...estimatedRunSpend(spend.month),
            },
          }
        : { outcome: check };
    },
    {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.home !== undefined ? { home: options.home } : {}),
    },
  );
}

function describeScope(scope: SpendScope): string {
  switch (scope.kind) {
    case "machine":
      return "machine-wide";
    case "goals":
      return "goals";
    case "agent":
      return `agent "${scope.key}"`;
  }
}

/** The config key that holds a cap, for telling somebody what to change. */
function capConfigKey(scope: SpendScope, period: CapPeriod, measure: CapMeasure = "cost"): string {
  const field =
    measure === "tokens" ? "dailyTokens" : period === "day" ? "dailyCostUSD" : "monthlyCostUSD";
  switch (scope.kind) {
    case "machine":
      return `daemon.${field}`;
    case "goals":
      return `daemon.goals.${field}`;
    case "agent":
      return `daemon.agents.${scope.key}.${field}`;
  }
}

function formatAmount(measure: CapMeasure, amount: number): string {
  return measure === "cost" ? `$${amount.toFixed(2)}` : `${amount.toLocaleString("en-US")} tokens`;
}

/** One sentence saying which cap blocks and how to lift it. */
export function describeCapCheck(check: BlockingCap): string {
  const key = capConfigKey(check.scope, check.period, check.measure);
  const resume =
    check.scope.kind === "machine" && check.period === "day"
      ? "run `jazz daemon resume` to lift it for today, "
      : "";
  const which = `The ${describeScope(check.scope)} ${check.period === "day" ? "daily" : "monthly"} cap (${formatAmount(check.measure, check.limit)})`;
  if (check.kind === "unverifiable") {
    const runs = `${check.unpricedRuns} unattended run${check.unpricedRuns === 1 ? "" : "s"}`;
    return `${which} cannot be verified: ${runs} today had no pricing, so their cost is unknown (${formatAmount(check.measure, check.spent)} priced). Use a priced model, cap tokens with daemon.dailyTokens, ${resume}or clear ${key}, or wait for tomorrow.`;
  }
  return `${which} is reached: ${formatAmount(check.measure, check.spent)} spent by unattended runs. Wait for the next ${check.period}, ${resume}raise ${key} (jazz config set ${key} <amount>), or clear it.`;
}

/** A run refused because a spend cap covering it blocks. */
export class SpendCapReachedError extends Error {
  override readonly name = "SpendCapReachedError";
  constructor(readonly check: BlockingCap) {
    super(describeCapCheck(check));
  }
}

/** A key that stays the same for one cap, state and window, for notifying once per window. */
export function capWindowKey(
  check: BlockingCap,
  spend: Pick<SpendReport, "day" | "monthKey">,
): string {
  const window = check.period === "day" ? spend.day : spend.monthKey;
  return `spend:${capConfigKey(check.scope, check.period, check.measure)}:${check.kind}:${window}`;
}

/** One configured cap and where spend stands against it, for `jazz spend` and daemon status. */
export interface CapStatus {
  readonly key: string;
  readonly scope: SpendScope;
  readonly period: CapPeriod;
  readonly measure: CapMeasure;
  readonly limit: number;
  /** Priced spend in the window. */
  readonly spent: number;
  /** Runs in the window with no price, whose dollars are missing from `spent`. */
  readonly unpricedRuns: number;
  /** `spent` is at or above `limit`. */
  readonly reached: boolean;
  /** A daily dollar cap under its limit with unpriced runs today: it blocks as if reached. */
  readonly unverifiable: boolean;
  /** Set on a machine daily cap `jazz daemon resume` lifted: the ISO time the lift ends. */
  readonly liftedUntil?: string;
}

export interface CapStatusOptions {
  /** Resolves `daemon.agents` keys given by name. */
  readonly agents?: readonly CapAgent[];
  /** When `jazz daemon resume` lifted the machine daily caps, the ISO time the lift ends. */
  readonly machineCapLiftedUntil?: string;
}

/** Every configured cap, with the spend in its window. */
export function capStatuses(
  config: DaemonConfig | undefined,
  spend: Pick<SpendReport, "today" | "month">,
  options: CapStatusOptions = {},
): readonly CapStatus[] {
  return capRules(config, undefined, options.agents).map((rule) => {
    const { spent, unpricedRuns } = spentFor(rule, spend);
    const state = ruleState(rule, spent, unpricedRuns);
    const liftedUntil =
      rule.scope.kind === "machine" && rule.period === "day"
        ? options.machineCapLiftedUntil
        : undefined;
    return {
      key: capConfigKey(rule.scope, rule.period, rule.measure),
      ...rule,
      spent,
      unpricedRuns,
      reached: state === "reached",
      unverifiable: state === "unverifiable",
      ...(liftedUntil !== undefined ? { liftedUntil } : {}),
    };
  });
}

/**
 * The machine-wide daily cap that blocks today's unattended work, reached or unverifiable, or
 * undefined: what pauses the daemon until midnight.
 */
export function blockingMachineDailyCap(
  config: DaemonConfig | undefined,
  spend: Pick<SpendReport, "today" | "month">,
): CapMeasure | undefined {
  const blocking = capStatuses(config, spend).find(
    (status) =>
      status.scope.kind === "machine" &&
      status.period === "day" &&
      (status.reached || status.unverifiable),
  );
  return blocking?.measure;
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
