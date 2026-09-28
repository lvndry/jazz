/**
 * @fileoverview Reading a bridge's environment the same way in every bridge.
 *
 * Each bridge grew its own on/off parser, and they disagreed: one accepted `no`, one did not,
 * one read "unset" as on where the others read it as off. A setting that means the same
 * thing everywhere is parsed by one function.
 */

const TRUE_WORDS: ReadonlySet<string> = new Set(["1", "true", "on", "yes"]);
const FALSE_WORDS: ReadonlySet<string> = new Set(["0", "false", "off", "no"]);

/** `true`/`false` for a recognised word, undefined for unset, empty or anything else. */
export function parseFlag(raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value.length === 0) return undefined;
  if (TRUE_WORDS.has(value)) return true;
  if (FALSE_WORDS.has(value)) return false;
  return undefined;
}

/** An on/off setting: `defaultOn` when unset, otherwise anything but an "off" word is on. */
export function envFlag(
  name: string,
  defaultOn: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return defaultOn;
  return !FALSE_WORDS.has(raw.trim().toLowerCase());
}

/** A positive whole number, or `fallback` when unset or not one. */
export function envPositiveInt(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const parsed = Number.parseInt(env[name]?.trim() ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * How many agent runs one bridge process has in flight at once, across every conversation.
 * Each run is a full `jazz` process that may start a browser, so an unbounded number of
 * chats talking at once is an unbounded number of those.
 */
const DEFAULT_MAX_CONCURRENT_RUNS = 4;

/**
 * How many messages may wait behind a conversation's current run. Each one becomes its own
 * run in turn, so a burst of forty would hold the chat for forty runs.
 */
const DEFAULT_MAX_QUEUED_MESSAGES = 5;

export interface RunLimits {
  readonly maxConcurrentRuns: number;
  readonly maxQueuedMessages: number;
}

/** `JAZZ_BOT_MAX_CONCURRENT_RUNS` and `JAZZ_BOT_MAX_QUEUED_MESSAGES`, shared by every bridge. */
export function runLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): RunLimits {
  return {
    maxConcurrentRuns: envPositiveInt(
      "JAZZ_BOT_MAX_CONCURRENT_RUNS",
      DEFAULT_MAX_CONCURRENT_RUNS,
      env,
    ),
    maxQueuedMessages: envPositiveInt(
      "JAZZ_BOT_MAX_QUEUED_MESSAGES",
      DEFAULT_MAX_QUEUED_MESSAGES,
      env,
    ),
  };
}
