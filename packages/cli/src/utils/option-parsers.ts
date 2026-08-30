/**
 * Commander.js option parsers shared across CLI command definitions.
 */

import { parseDurationMs as parseDuration } from "@jazz/core/utils/time";

/**
 * Build a Commander option parser that accepts only positive integers.
 *
 * Commander passes option values as raw strings; this validates and coerces
 * them, throwing a clear error (which Commander surfaces to the user) when the
 * value is not a positive integer.
 *
 * @param label - The flag name used in the error message (e.g. "--timeout").
 */
export function parsePositiveInt(label: string) {
  return (raw: string): number => {
    // Reject trailing non-digits — Number.parseInt would silently accept "30s"
    // as 30, which is a dangerous footgun for flags like --timeout.
    if (!/^\d+$/.test(raw)) {
      throw new Error(`${label} must be a positive integer (got "${raw}").`);
    }
    const value = Number.parseInt(raw, 10);
    if (value <= 0) {
      throw new Error(`${label} must be a positive integer (got "${raw}").`);
    }
    return value;
  };
}

/**
 * Build a Commander option parser that accepts only positive (fractional) numbers, for
 * dollar-amount flags like --max-cost-usd where "20" or "0.20" both make sense but "20s"
 * or a negative amount do not.
 *
 * @param label - The flag name used in the error message (e.g. "--max-cost-usd").
 */
export function parsePositiveFloat(label: string) {
  return (raw: string): number => {
    if (!/^\d+(\.\d+)?$/.test(raw)) {
      throw new Error(`${label} must be a positive number (got "${raw}").`);
    }
    const value = Number.parseFloat(raw);
    if (!(value > 0)) {
      throw new Error(`${label} must be a positive number (got "${raw}").`);
    }
    return value;
  };
}

/**
 * Build a Commander option parser for a short human duration like `24h`, `30m`, `1h30m` — the
 * shape `--expires` takes. Delegates to the same duration parser `parseWhen` (reminders) uses,
 * so this is deliberately not re-implementing unit parsing here.
 */
export function parseDurationMs(label: string) {
  return (raw: string): number => {
    const ms = parseDuration(raw);
    if (ms === null) {
      throw new Error(`${label} must look like "30m", "24h", or "7d" (got "${raw}").`);
    }
    return ms;
  };
}
