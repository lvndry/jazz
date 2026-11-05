/**
 * Deterministic scrubbing for recorded session fixtures.
 *
 * A recorded session is committed to a public repository, so every value that identifies a
 * person, a machine, a moment or a credential is replaced by a stable placeholder before it is
 * written. `createScrubber` returns a stateful scrubber: random ids map to `<ID:n>` numbered by
 * first appearance, so the same id is the same placeholder across every model call of one
 * fixture and two recordings of the same session scrub to the same bytes.
 *
 * Scrubbing is value-based and key-based: known secret values (`secrets`) are replaced
 * wherever they appear, credential-shaped tokens are replaced by pattern, and the values of keys
 * that name a credential are replaced whole. Host facts (home directory, username, hostname,
 * temp directory) come from `hostFacts` so tests can pin them.
 *
 * Use `scrubber.scrub(value)` on any JSON-shaped value; it returns a new value and never
 * mutates its input.
 */

import os from "node:os";

export const REDACTED_PLACEHOLDER = "<REDACTED>";
export const HOME_PLACEHOLDER = "<HOME>";
export const USER_PLACEHOLDER = "<USER>";
export const HOST_PLACEHOLDER = "<HOST>";
export const TMPDIR_PLACEHOLDER = "<TMPDIR>";
export const TIMESTAMP_PLACEHOLDER = "<TIMESTAMP>";

/** Matches a key whose value is a credential regardless of what the value looks like. */
const SECRET_KEY_PATTERN =
  /^(?:api[_-]?key|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|cookie|set-cookie)$/i;

/** Matches a key holding an epoch timestamp in milliseconds or seconds. */
const EPOCH_KEY_PATTERN = /^(?:timestamp|created|createdAt|updatedAt|startedAt|time)$/i;

/** Credential-shaped tokens recognized by their prefix, whatever key they sit under. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const ISO_TIMESTAMP_PATTERN =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

/** Random identifiers: UUIDs and provider call/message ids. */
const RANDOM_ID_PATTERNS: readonly RegExp[] = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b(?:call|toolu|chatcmpl|msg|resp|req|gen)[_-][A-Za-z0-9]{8,}/g,
];

/** Facts about the recording machine that must not survive into a fixture. */
export interface HostFacts {
  readonly home: string;
  readonly username: string;
  readonly hostname: string;
  readonly tmpdir: string;
}

export function currentHostFacts(): HostFacts {
  return {
    home: os.homedir(),
    username: os.userInfo().username,
    hostname: os.hostname(),
    tmpdir: os.tmpdir(),
  };
}

export interface ScrubberOptions {
  /** Exact secret values to remove wherever they appear. */
  readonly secrets?: readonly string[];
  readonly hostFacts?: HostFacts;
}

export interface Scrubber {
  scrub<Value>(value: Value): Value;
  scrubString(text: string): string;
}

/** Shorter literals would match inside unrelated words, so they are not scrubbed as facts. */
const MIN_LITERAL_LENGTH = 3;

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createScrubber(options: ScrubberOptions = {}): Scrubber {
  const facts = options.hostFacts ?? currentHostFacts();
  const secrets = [...(options.secrets ?? [])]
    .filter((secret) => secret.length >= MIN_LITERAL_LENGTH)
    .sort((left, right) => right.length - left.length);
  const idPlaceholders = new Map<string, string>();

  const literalReplacements: Array<readonly [RegExp, string]> = [];
  for (const secret of secrets) {
    literalReplacements.push([new RegExp(escapeForRegExp(secret), "g"), REDACTED_PLACEHOLDER]);
  }
  const pathFacts: Array<readonly [string, string]> = [
    [facts.tmpdir, TMPDIR_PLACEHOLDER],
    [facts.home, HOME_PLACEHOLDER],
  ];
  for (const [value, placeholder] of pathFacts) {
    if (value.length >= MIN_LITERAL_LENGTH) {
      literalReplacements.push([new RegExp(escapeForRegExp(value), "g"), placeholder]);
    }
  }
  if (facts.hostname.length >= MIN_LITERAL_LENGTH) {
    literalReplacements.push([
      new RegExp(`\\b${escapeForRegExp(facts.hostname)}\\b`, "gi"),
      HOST_PLACEHOLDER,
    ]);
  }
  if (facts.username.length >= MIN_LITERAL_LENGTH) {
    literalReplacements.push([
      new RegExp(`\\b${escapeForRegExp(facts.username)}\\b`, "g"),
      USER_PLACEHOLDER,
    ]);
  }

  const stableId = (id: string): string => {
    let placeholder = idPlaceholders.get(id);
    if (placeholder === undefined) {
      placeholder = `<ID:${idPlaceholders.size + 1}>`;
      idPlaceholders.set(id, placeholder);
    }
    return placeholder;
  };

  const scrubString = (text: string): string => {
    let scrubbed = text;
    for (const [pattern, replacement] of literalReplacements) {
      scrubbed = scrubbed.replace(pattern, replacement);
    }
    for (const pattern of CREDENTIAL_PATTERNS) {
      scrubbed = scrubbed.replace(pattern, REDACTED_PLACEHOLDER);
    }
    scrubbed = scrubbed.replace(ISO_TIMESTAMP_PATTERN, TIMESTAMP_PLACEHOLDER);
    for (const pattern of RANDOM_ID_PATTERNS) {
      scrubbed = scrubbed.replace(pattern, (match) => stableId(match));
    }
    return scrubbed;
  };

  const scrubUnknown = (value: unknown): unknown => {
    if (typeof value === "string") {
      return scrubString(value);
    }
    if (Array.isArray(value)) {
      return value.map((item: unknown) => scrubUnknown(item));
    }
    if (typeof value === "object" && value !== null) {
      const scrubbedEntries: Array<[string, unknown]> = [];
      for (const [key, child] of Object.entries(value)) {
        if (SECRET_KEY_PATTERN.test(key) && child !== null && child !== undefined) {
          scrubbedEntries.push([key, REDACTED_PLACEHOLDER]);
        } else if (EPOCH_KEY_PATTERN.test(key) && typeof child === "number") {
          scrubbedEntries.push([key, 0]);
        } else {
          scrubbedEntries.push([scrubString(key), scrubUnknown(child)]);
        }
      }
      return Object.fromEntries(scrubbedEntries);
    }
    return value;
  };

  return {
    scrub: <Value>(value: Value): Value => scrubUnknown(value) as Value,
    scrubString,
  };
}
