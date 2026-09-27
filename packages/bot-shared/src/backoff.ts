/**
 * @fileoverview How long to wait before reconnecting, after the attempts so far.
 *
 * A fixed delay hammers a platform that is down, and every bridge restarting at once after
 * an outage retries in lockstep. Exponential growth with full jitter (a random wait up to
 * the exponential bound) spreads the retries out and backs off a persistent failure.
 */

export interface BackoffOptions {
  /** The bound for the first retry. */
  readonly baseMs: number;
  /** The bound never grows past this. */
  readonly maxMs: number;
}

/** A random delay in `[0, min(maxMs, baseMs * 2^attempt)]`; `attempt` counts from 0. */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  const bound = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt));
  return Math.round(random() * bound);
}
