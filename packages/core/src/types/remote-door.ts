/**
 * @fileoverview The rules every remote door shares: who is calling, and how much one call may
 * cost.
 *
 * Two doors on this machine start runs for somebody who is not the operator: a webhook fired by
 * an external system, and a peer's agent asking a question (over `/peer/ask` or `/a2a`). Both
 * need the same three answers, so they live here rather than in either door:
 *
 * - **Who is on the other end** ({@link RemoteCaller}). A run started for a remote caller gets
 *   none of the operator's own context: no standing preferences, no AGENTS.md, and no local
 *   files attached on the strength of a path in the caller's text. A parked record carries the
 *   caller, so a resumed run keeps the same boundary.
 * - **What one run may spend** ({@link RunBudget}). A door's budget caps each run it starts,
 *   including a run resumed after a park.
 * - **How many runs may be in flight at once** ({@link DoorLimits.maxConcurrentRuns}). A caller
 *   past the cap is answered `429` instead of queued behind the operator's own work.
 *
 * No runtime imports: `types/peer` imports this, and that module sits on the CLI's startup
 * path.
 */

/** Which kind of remote door started a run. `/a2a` is the peer door in another wire format. */
export type RemoteDoor = "webhook" | "peer";

/** The caller of a remote door: the door, and the configured webhook or peer name. */
export interface RemoteCaller {
  readonly door: RemoteDoor;
  readonly name: string;
}

/**
 * What one run may spend. Each cap is optional, and an absent one falls back to the app-wide
 * cap of the same name.
 */
export interface RunBudget {
  readonly maxTokens?: number;
  readonly maxCostUSD?: number;
  readonly maxDurationMs?: number;
}

/** The per-door limits a webhook or peer config may set. */
export interface DoorLimits {
  /** Caps on each run this door starts. */
  readonly budget?: RunBudget;
  /**
   * Runs this door may have in flight at once. A request past it is refused with `429`.
   * Absent means {@link DEFAULT_MAX_CONCURRENT_DOOR_RUNS}.
   */
  readonly maxConcurrentRuns?: number;
}

/**
 * How many runs one door may have in flight when its config does not say.
 *
 * Every run holds a model stream and possibly a shell open, so a door that anyone holding its
 * credential can hammer must not be able to start an unbounded number. Four covers a burst of
 * related events (a GitHub push that also opens a PR and a check run) without letting one noisy
 * sender saturate the machine.
 */
export const DEFAULT_MAX_CONCURRENT_DOOR_RUNS = 4;

/** A budget's caps as run options, leaving out the ones it does not set. */
export function runBudgetOptions(budget: RunBudget | undefined): RunBudget {
  return {
    ...(budget?.maxTokens !== undefined ? { maxTokens: budget.maxTokens } : {}),
    ...(budget?.maxCostUSD !== undefined ? { maxCostUSD: budget.maxCostUSD } : {}),
    ...(budget?.maxDurationMs !== undefined ? { maxDurationMs: budget.maxDurationMs } : {}),
  };
}
