import cronParser from "cron-parser";

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
 * Supports both 5-field (standard cron) and 6-field (with seconds) formats.
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
