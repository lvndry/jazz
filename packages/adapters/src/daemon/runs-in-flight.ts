/**
 * Which claimed runs (goal cycles, loop runs, reminder and wake-trigger deliveries, batch
 * fan-in) this process is executing, and what can be said about a claim's owner from here.
 *
 * A claim names the process that took it. A claim owned by this process but missing from the
 * in-flight set died here (a defect, an interrupt) and will not settle itself; a claim owned by
 * another process is judged by that process's pid and start time.
 */
import { hostname } from "node:os";
import { localOwnerStatus, type ProcessOwner } from "@jazz/core/utils/process";
import { Effect } from "effect";

const runsInFlight = new Set<string>();

/** Whether `owner` names this very process. */
export function isThisProcess(owner: ProcessOwner | undefined): boolean {
  return owner !== undefined && owner.pid === process.pid && owner.host === hostname();
}

/**
 * Whether a claimed run is still being worked on. This process's own in-flight set is checked
 * first, so a hostname change mid-run cannot make it disown a run it is executing.
 */
export function claimOwnerStatus(
  owner: ProcessOwner,
  runId: string,
): "alive" | "gone" | "unverifiable" {
  if (runsInFlight.has(runId)) {
    return "alive";
  }
  if (isThisProcess(owner)) {
    return "gone";
  }
  return localOwnerStatus(owner);
}

/**
 * Mark a claim as executing in this process from the moment it is taken, before the work is
 * forked, so a tick that runs in between cannot judge this process's own claim abandoned.
 * Pair every call with {@link clearInFlight}.
 */
export function markInFlight(claimKey: string): void {
  runsInFlight.add(claimKey);
}

/** End a claim marked with {@link markInFlight}. */
export function clearInFlight(claimKey: string): void {
  runsInFlight.delete(claimKey);
}

/** Mark a claimed run as executing in this process for the duration of `work`. */
export function inFlight<A, E, R>(
  runId: string,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => runsInFlight.add(runId)),
    () => work,
    () => Effect.sync(() => runsInFlight.delete(runId)),
  );
}
