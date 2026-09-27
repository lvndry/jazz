/**
 * Human-readable durations for messages a person or a model reads ("850ms", "12s", "3m 5s",
 * "1h 2m"). Rounds to the unit shown, never down to zero: a 20-second timeout reads "20s", not
 * "0m".
 */

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** Format a millisecond duration at the coarsest unit that still keeps it readable. */
export function formatDuration(durationMs: number): string {
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < MS_PER_SECOND) {
    return `${ms}ms`;
  }
  if (ms < MS_PER_MINUTE) {
    return `${Math.round(ms / MS_PER_SECOND)}s`;
  }
  if (ms < MS_PER_HOUR) {
    const minutes = Math.floor(ms / MS_PER_MINUTE);
    const seconds = Math.round((ms % MS_PER_MINUTE) / MS_PER_SECOND);
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.round((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}
