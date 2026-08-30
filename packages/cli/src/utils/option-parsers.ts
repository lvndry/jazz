/**
 * Commander.js option parsers shared across CLI command definitions.
 */

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

function durationUnitMs(unit: "s" | "m" | "h" | "d"): number {
  switch (unit) {
    case "s":
      return 1_000;
    case "m":
      return 60_000;
    case "h":
      return 3_600_000;
    case "d":
      return 86_400_000;
  }
}

/**
 * Build a Commander option parser for a short human duration like `24h`, `30m`, `10d` — the
 * shape `--expires` takes. Only single-unit durations are accepted (no `1h30m`): an invite's
 * lifetime is not a value anyone needs sub-unit precision on, and rejecting the compound form
 * keeps the error message simple when someone fat-fingers it.
 */
export function parseDurationMs(label: string) {
  return (raw: string): number => {
    const match = /^(\d+)(s|m|h|d)$/.exec(raw.trim());
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`${label} must look like "30m", "24h", or "7d" (got "${raw}").`);
    }
    const amount = Number.parseInt(match[1], 10);
    if (amount <= 0) {
      throw new Error(`${label} must be a positive duration (got "${raw}").`);
    }
    return amount * durationUnitMs(match[2] as "s" | "m" | "h" | "d");
  };
}
