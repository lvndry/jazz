/**
 * Which claimed runs (goal cycles, loop runs) this process is executing, and what can be said
 * about a claim's owner from here.
 *
 * A claim names the process that took it. A claim owned by this process but missing from the
 * in-flight set died here (a defect, an interrupt) and will not settle itself; a claim owned by
 * another process is judged by that process's pid and start time.
 */
import { hostname } from "node:os";
import { localOwnerStatus, type ProcessOwner } from "@jazz/core/utils/process";
import { Effect } from "effect";

const runsInFlight = new Set<string>();

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
  if (owner.pid === process.pid && owner.host === hostname()) {
    return "gone";
  }
  return localOwnerStatus(owner);
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
