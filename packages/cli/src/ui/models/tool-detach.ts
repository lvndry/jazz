/**
 * When Ctrl+B is worth advertising: a tool call has been running long enough that sending it to
 * the background beats waiting on it. Both renderers read this one rule, so the hint appears
 * and disappears at the same moment whichever interface is drawing the run.
 */

import type { ActivityState } from "../activity-state";

/**
 * Most tool calls finish within a couple of seconds; a hint shown sooner would flash on and
 * off for every file read instead of marking the calls that are actually holding the turn up.
 */
export const DETACH_HINT_DELAY_MS = 3_000;

/**
 * Whether Ctrl+B would detach something right now and the call has run past
 * {@link DETACH_HINT_DELAY_MS}. `canDetach` is whether the run installed a background handler.
 * A call still being risk-classified has not started its real work yet, so it does not count.
 */
export function offersDetach(activity: ActivityState, canDetach: boolean, now: number): boolean {
  if (!canDetach || activity.phase !== "tool-execution") {
    return false;
  }
  return activity.tools.some(
    (tool) => tool.classifying !== true && now - tool.startedAt >= DETACH_HINT_DELAY_MS,
  );
}
