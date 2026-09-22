/**
 * Builds a local-only misfire report from the misfire log.
 *
 * The report is an allowlisted shape: counts, durations, the tool, and an error
 * class derived from the message rather than the message itself. Nothing here
 * transmits anything; external reporting is a separate, confirmed operation
 * that must consume only this shape.
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

/** Longest error class kept; a class is a label, not a message. */
const MAX_ERROR_CLASS_LENGTH = 120;

const SECRET_KEY =
  /authorization|api[-_]?key|token|secret|password|cookie|credential|private[-_]?key/i;
const HOME_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s"']+/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
/** International form only: a bare run of digits is far more often a size or a timestamp. */
const PHONE = /\+\d[\d ()-]{7,}\d/g;

/** Strips the identifiers that most often leak into free text. */
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

/**
 * Reduces an error message to a class that repeats across runs.
 *
 * Only the first line is kept — anything after it is a stack or the payload
 * that failed — and every digit run becomes `#`, so "line 42" and "line 57"
 * are the same class. Identifiers are stripped before the cut so a long path
 * at the start cannot push the informative part past the limit.
 */
export function misfireErrorClass(message: string): string {
  const firstLine = message.split("\n").find((line) => line.trim().length > 0) ?? "";
  return sanitizeMisfireText(firstLine.trim())
    .replace(/\d+/g, "#")
    .slice(0, MAX_ERROR_CLASS_LENGTH);
}

/**
 * Aggregates the misfires that share the first entry's tool and kind into one
 * report. Entries for other tools are left out rather than miscounted under
 * this tool's name.
 */
export function buildSafeMisfireReport(
  entries: readonly MisfireEntry[],
  options: { readonly jazzVersion: string; readonly platform: string },
): SafeMisfireReport | undefined {
  const first = entries[0];
  if (first === undefined) return undefined;
  const related = entries.filter(
    (entry) => entry.toolName === first.toolName && entry.kind === first.kind,
  );
  const durations = related.map((entry) => entry.durationMs);
  return {
    jazzVersion: options.jazzVersion,
    platform: options.platform,
    toolName: first.toolName,
    kind: first.kind,
    errorClass: misfireErrorClass(first.errorMessage),
    occurrences: related.length,
    durationMs: {
      min: Math.min(...durations),
      max: Math.max(...durations),
    },
  };
}
