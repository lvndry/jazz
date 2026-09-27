/**
 * @fileoverview Where a run came from, for the spend ledger and the notify channel.
 *
 * Every entry point that starts a run names its source. The source decides two things: which
 * line of `jazz spend` the cost lands on, and whether a reached spend ceiling refuses the run
 * (nobody is there to decide, so it must not start) or only warns (a person is typing and
 * can stop).
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

/**
 * Sources where a person is present to decide. `resume` is a parked run somebody just
 * answered: stopping the work they approved would waste the approval.
 */
const ATTENDED_SOURCES: ReadonlySet<SpendSource> = new Set(["chat", "bot", "resume"]);

/** Whether nobody is present to decide, so a reached ceiling must refuse the run. */
export function isUnattendedSource(source: SpendSource): boolean {
  return !ATTENDED_SOURCES.has(source);
}

/** Sources the `spend.goals` ceilings cover: work that keeps going on its own. */
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
