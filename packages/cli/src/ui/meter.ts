/**
 * The context meter's rules, shared by the header gauge and the `/context` report so the
 * two can never disagree about when a window counts as filling up.
 */

import {
  CONTEXT_TRIM_THRESHOLD_RATIO,
  CONTEXT_WARN_THRESHOLD_RATIO,
} from "@jazz/core/agent/context/context-window-manager";

/**
 * The meter follows the agent's own context ladder: it warms where the agent starts
 * warning (before it compacts), and turns red only where history would be trimmed
 * without being summarised.
 */
export const CONTEXT_WARN_PERCENT = CONTEXT_WARN_THRESHOLD_RATIO * 100;
export const CONTEXT_ERROR_PERCENT = CONTEXT_TRIM_THRESHOLD_RATIO * 100;

/** Whole percent of `max` that `used` covers, clamped to 0–100. */
export function contextPercent(used: number, max: number): number {
  if (!(max > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((used / max) * 100)));
}

/**
 * The lit run of a meter: the accent while calm, warning once usage is above the agent's
 * warning line, and error from the trim budget on, where history starts being cut.
 */
export function meterTone(percent: number): "accent" | "warning" | "error" {
  if (percent >= CONTEXT_ERROR_PERCENT) {
    return "error";
  }
  if (percent > CONTEXT_WARN_PERCENT) {
    return "warning";
  }
  return "accent";
}

/** Any use at all lights one cell, so a live session never looks like an empty gauge. */
export function meterFilledCells(percent: number, cells: number): number {
  if (percent <= 0) {
    return 0;
  }
  return Math.min(cells, Math.max(1, Math.round((percent / 100) * cells)));
}
