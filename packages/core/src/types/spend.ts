/**
 * Spend ceilings: how much every run on this machine, one agent, or goal work may spend per
 * local calendar day and month. Every ceiling is unset, meaning unlimited, until somebody sets
 * one. See `spend/ceilings.ts` for how they are enforced.
 */

/** A day and a month ceiling, in USD. Either may be unset (unlimited). */
export interface SpendLimits {
  readonly dayUSD?: number;
  readonly monthUSD?: number;
}

export interface SpendConfig extends SpendLimits {
  /** Ceilings on goal cycles and loop runs together. */
  readonly goals?: SpendLimits;
  /** Ceilings on one agent's runs, keyed by agent id. */
  readonly agents?: Readonly<Record<string, SpendLimits>>;
}
