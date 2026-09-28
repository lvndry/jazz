/**
 * Process-lifetime credentials loaded by adapters that are not part of effective configuration.
 * Register values when they enter memory so tool output and logs redact them immediately, including
 * after a rotating credential changes during a long run. Names are internal redaction labels.
 */

import type { KnownSecret } from "@/core/secrets/redaction";

const secrets = new Map<string, string>();

/** Hold the current process value for `name` as a known secret for redaction. */
export function registerRuntimeSecret(name: string, value: string): void {
  if (value.length === 0) {
    secrets.delete(name);
    return;
  }
  secrets.set(name, value);
}

/** Forget a process secret when its credential is cleared. */
export function clearRuntimeSecret(name: string): void {
  secrets.delete(name);
}

/** Return the current process secrets as known values, longest first for exact redaction. */
export function runtimeSecretsForRedaction(): KnownSecret[] {
  return [...secrets.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value.length - left.value.length);
}
