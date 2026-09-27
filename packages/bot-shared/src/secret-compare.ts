/**
 * @fileoverview Comparing a secret a caller presented with the one configured.
 *
 * `!==` returns at the first differing byte, so the response time says how much of a guess
 * was right and a secret can be found one character at a time. Both sides are hashed first so
 * the comparison runs over equal lengths, which `timingSafeEqual` needs and which also keeps
 * the configured secret's length out of the timing.
 */

import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Whether `presented` is the configured secret. An empty configured secret matches nothing. */
export function secretsMatch(expected: string, presented: string | null | undefined): boolean {
  if (expected.length === 0 || presented === null || presented === undefined) {
    return false;
  }
  return timingSafeEqual(digest(expected), digest(presented));
}
