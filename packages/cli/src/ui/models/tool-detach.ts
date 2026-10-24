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
 * Whether one call has run past {@link DETACH_HINT_DELAY_MS}. A call still being risk-classified
 * has not started its real work yet, so it does not count.
 */
export function toolHoldsTurnUp(
  tool: { readonly startedAt: number; readonly classifying?: boolean },
  now: number,
): boolean {
  return tool.classifying !== true && now - tool.startedAt >= DETACH_HINT_DELAY_MS;
}

/** Whether any running call holds the turn up (see {@link toolHoldsTurnUp}). */
export function holdsTurnUp(activity: ActivityState, now: number): boolean {
  if (activity.phase !== "tool-execution") {
    return false;
  }
  return activity.tools.some((tool) => toolHoldsTurnUp(tool, now));
}

/**
 * Whether Ctrl+B would detach something right now and a call is holding the turn up.
 * `canDetach` is whether the run installed a background handler.
 */
export function offersDetach(activity: ActivityState, canDetach: boolean, now: number): boolean {
  return canDetach && holdsTurnUp(activity, now);
}

/**
 * The words for the Ctrl+B hint. Ctrl+B backgrounds the whole running batch, so with more than
 * one call in flight the hint says so rather than reading as an action on a single call.
 */
export function detachHint(activity: ActivityState): string {
  const running = activity.phase === "tool-execution" ? activity.tools.length : 0;
  return running > 1 ? "ctrl+b to background all" : "ctrl+b to background";
}
