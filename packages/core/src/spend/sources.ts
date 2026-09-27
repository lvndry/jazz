/**
 * @fileoverview Where a run came from, for the spend ledger and the notify channel.
 *
 * Every entry point that starts a run names its source: which line of `jazz spend` the cost
 * lands on, which `daemon.goals` caps cover it, and how a notification names it. Whether a
 * reached cap refuses the run is decided by whether anyone could be asked while it runs (see
 * `spend/run-accounting.ts`), not by its source.
 */

export const SPEND_SOURCES = [
  "chat",
  "run",
  "workflow",
  "goal",
  "loop",
  "wake-trigger",
  "job",
  "webhook",
  "peer",
  "daemon",
  "bot",
  "detached",
  "resume",
] as const;

export type SpendSource = (typeof SPEND_SOURCES)[number];

/** A run's source plus the name a person knows it by (the workflow, goal or webhook name). */
export interface RunOrigin {
  readonly source: SpendSource;
  readonly name?: string;
  /**
   * Notify channels this run reports to on top of the subscribed ones: a workflow's
   * `deliver:` channels hear about its failures and approvals, not only its results.
   */
  readonly deliverTo?: readonly string[];
}

/** Sources the `daemon.goals` caps cover: goal cycles and loop runs, wherever they run. */
const AUTONOMOUS_SOURCES: ReadonlySet<SpendSource> = new Set(["goal", "loop"]);

export function isGoalSource(source: SpendSource): boolean {
  return AUTONOMOUS_SOURCES.has(source);
}

/** How a person reads a source in `jazz spend` and in notifications. */
export const SPEND_SOURCE_LABELS: Readonly<Record<SpendSource, string>> = {
  chat: "chat",
  run: "jazz run",
  workflow: "workflows",
  goal: "goals",
  loop: "loops",
  "wake-trigger": "wake triggers",
  job: "job batches",
  webhook: "webhooks",
  peer: "peers",
  daemon: "daemon API",
  bot: "chat bots",
  detached: "detached jobs",
  resume: "resumed runs",
};
