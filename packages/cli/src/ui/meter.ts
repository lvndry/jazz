/**
 * The context meter's rules, shared by the header gauge and the `/context` report so the
 * two can never disagree about when a window counts as filling up.
 */

/** A context window filling up is worth noticing before it is a problem. */
export const CONTEXT_WARN_PERCENT = 80;
export const CONTEXT_ERROR_PERCENT = 92;

/** Whole percent of `max` that `used` covers, clamped to 0–100. */
export function contextPercent(used: number, max: number): number {
  if (!(max > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((used / max) * 100)));
}

/** The lit run of a meter: the accent while calm, then warning, then error. */
export function meterTone(percent: number): "accent" | "warning" | "error" {
  if (percent > CONTEXT_ERROR_PERCENT) return "error";
  if (percent > CONTEXT_WARN_PERCENT) return "warning";
  return "accent";
}

/** Any use at all lights one cell, so a live session never looks like an empty gauge. */
export function meterFilledCells(percent: number, cells: number): number {
  if (percent <= 0) {
    return 0;
  }
  return Math.min(cells, Math.max(1, Math.round((percent / 100) * cells)));
}
