/**
 * When the keys for a slow tool call are worth advertising: a call has been running long enough
 * that sending it to the background or interrupting it beats waiting on it. Both renderers read
 * this one rule, so the hints appear and disappear at the same moment whichever interface is
 * drawing the run.
 */

import type { ActivityState } from "../activity-state";

/**
 * Most tool calls finish within a couple of seconds; a hint shown sooner would flash on and
 * off for every file read instead of marking the calls that are actually holding the turn up.
 */
export const DETACH_HINT_DELAY_MS = 3_000;

/**
 * Whether a call has run past {@link DETACH_HINT_DELAY_MS}. A call still being risk-classified
 * has not started its real work yet, so it does not count.
 */
export function holdsTurnUp(activity: ActivityState, now: number): boolean {
  if (activity.phase !== "tool-execution") {
    return false;
  }
  return activity.tools.some(
    (tool) => tool.classifying !== true && now - tool.startedAt >= DETACH_HINT_DELAY_MS,
  );
}

/**
 * Whether Ctrl+B would detach something right now and a call is holding the turn up.
 * `canDetach` is whether the run installed a background handler.
 */
export function offersDetach(activity: ActivityState, canDetach: boolean, now: number): boolean {
  return canDetach && holdsTurnUp(activity, now);
}
