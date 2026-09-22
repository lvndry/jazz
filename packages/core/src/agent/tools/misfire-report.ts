/**
 * Builds privacy-safe, local-only misfire report candidates.
 *
 * This module deliberately exports an allowlisted shape rather than attempting to
 * redact arbitrary report prose. External transmission is a separate, confirmed
 * operation and must consume only this safe shape.
 */

import type { MisfireEntry } from "./misfire-log";

export interface SafeMisfireReport {
  readonly jazzVersion: string;
  readonly platform: string;
  readonly toolName: string;
  readonly kind: string;
  readonly errorClass: string;
  readonly occurrences: number;
  readonly durationMs: { readonly min: number; readonly max: number };
}

const SECRET_KEY =
  /authorization|api[-_]?key|token|secret|password|cookie|credential|private[-_]?key/i;
const HOME_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s"']+/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /\+?\d[\d ()-]{7,}\d/g;

/** Normalize an error string without preserving arbitrary user-authored payloads. */
export function sanitizeMisfireText(value: string): string {
  return value
    .replace(HOME_PATH, "$HOME")
    .replace(UUID, "<id>")
    .replace(EMAIL, "<email>")
    .replace(PHONE, "<phone>")
    .slice(0, 500);
}

/** Recursively remove values under credential-bearing keys before local persistence/export. */
export function sanitizeMisfireValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeMisfireValue);
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? sanitizeMisfireText(value) : value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? "<redacted>" : sanitizeMisfireValue(nested);
  }
  return output;
}

/** Aggregate local misfires into a bounded report containing no raw arguments. */
export function buildSafeMisfireReport(
  entries: readonly MisfireEntry[],
  options: { readonly jazzVersion: string; readonly platform: string },
): SafeMisfireReport | undefined {
  const first = entries[0];
  if (first === undefined) return undefined;
  const durations = entries.map((entry) => entry.durationMs);
  return {
    jazzVersion: options.jazzVersion,
    platform: options.platform,
    toolName: first.toolName,
    kind: first.kind,
    errorClass: sanitizeMisfireText(first.errorMessage),
    occurrences: entries.length,
    durationMs: {
      min: Math.min(...durations),
      max: Math.max(...durations),
    },
  };
}
