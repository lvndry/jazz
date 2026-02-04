import cronParser from "cron-parser";
import cronstrue from "cronstrue";

/**
 * Normalize a cron expression to 6-field format (with seconds).
 * If the expression has 5 fields, prepend "0 " for seconds.
 * If it already has 6 fields, return as-is.
 */
export function normalizeCronExpression(schedule: string): string {
  const trimmed = schedule.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length === 5) {
    return `0 ${trimmed}`;
  }
  return trimmed;
}

/**
 * Validate a cron expression.
 * Returns true if valid, false otherwise.
 */
export function isValidCronExpression(cron: string): boolean {
  try {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5 && parts.length !== 6) {
      return false;
    }

    const normalized = normalizeCronExpression(cron);
    cronParser.parse(normalized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a human-readable description of a cron schedule, or null if not describable.
 */
export function describeCronSchedule(cron: string): string | null {
  try {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5 && parts.length !== 6) return null;

    const description = cronstrue.toString(cron.trim(), {
      verbose: false,
      use24HourTimeFormat: false,
    });

    return description;
  } catch {
    return null;
  }
}
