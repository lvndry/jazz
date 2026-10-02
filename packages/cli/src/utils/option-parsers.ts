/**
 * Commander.js option parsers shared across CLI command definitions.
 */

import { parseDurationMs as parseDuration } from "@jazz/core/utils/time";
import { InvalidArgumentError } from "commander";

/**
 * Build a Commander option parser that accepts only positive integers.
 *
 * Commander passes option values as raw strings; this validates and coerces
 * them, throwing Commander's `InvalidArgumentError` when the value is not a
 * positive integer, which Commander prints as a one-line usage error.
 *
 * @param label - The flag name used in the error message (e.g. "--timeout").
 */
export function parsePositiveInt(label: string) {
  return (raw: string): number => {
    // Reject trailing non-digits — Number.parseInt would silently accept "30s"
    // as 30, which is a dangerous footgun for flags like --timeout.
    if (!/^\d+$/.test(raw)) {
      throw new InvalidArgumentError(`${label} must be a positive integer (got "${raw}").`);
    }
    const value = Number.parseInt(raw, 10);
    if (value <= 0) {
      throw new InvalidArgumentError(`${label} must be a positive integer (got "${raw}").`);
    }
    return value;
  };
}

/**
 * Build a Commander option parser for iteration-cap flags: a whole number of 0 or more, where
 * 0 means unlimited. Distinguishes "0" (a valid, meaningful value) from "" (an empty
 * string), which is rejected.
 *
 * @param label - The flag name used in the error message (e.g. "--max-iterations").
 */
export function parseIterationCap(label: string) {
  return (raw: string): number => {
    if (!/^\d+$/.test(raw)) {
      throw new InvalidArgumentError(
        `${label} must be a whole number of 0 or more, where 0 means unlimited (got "${raw}").`,
      );
    }
    return Number.parseInt(raw, 10);
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
      throw new InvalidArgumentError(`${label} must be a positive number (got "${raw}").`);
    }
    const value = Number.parseFloat(raw);
    if (!(value > 0)) {
      throw new InvalidArgumentError(`${label} must be a positive number (got "${raw}").`);
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
      throw new InvalidArgumentError(
        `${label} must look like "30m", "24h", or "7d" (got "${raw}").`,
      );
    }
    return ms;
  };
}
