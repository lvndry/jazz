/**
 * Default iteration budget for a top-level run when neither --max-iterations nor config sets one.
 * Bounds unattended runs (headless, scripts, GitHub Actions). An attended terminal conversation
 * — where a person can type `continue` and the loop can run as long as the work needs — is
 * unlimited by default; this constant only stops runs nobody is watching.
 */
export const DEFAULT_MAX_ITERATIONS = 100;

/**
 * Default iteration budget for a sub-agent run on an unattended parent. Far below a top-level
 * run's: a sub-agent answers one scoped task, and every level gets a fresh budget. On an
 * attended terminal conversation the budget is unlimited, like the top-level run.
 */
export const DEFAULT_MAX_SUBAGENT_ITERATIONS = 30;

/**
 * Normalize a requested iteration cap to the value the loop actually uses: 0 means
 * "unlimited" and becomes Infinity, a positive whole number is floored, and undefined
 * falls back to the provided default. The CLI flag, config.json, and the /settings wizard
 * all accept 0; this is where that rule holds, so they cannot disagree.
 */
export function resolveIterationCap(requested: number | undefined, fallback: number): number {
  if (requested === undefined) {
    return Math.max(1, Math.floor(fallback));
  }
  if (requested === 0 || !Number.isFinite(requested)) {
    return Infinity;
  }
  return Math.max(1, Math.floor(requested));
}

/** Maximum number of tools that can execute concurrently */
export const MAX_CONCURRENT_TOOLS = 10;

/**
 * How many levels of sub-agent may nest below a top-level run. Every level gets
 * a fresh iteration budget, so depth is what bounds total delegated spend.
 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 3;

/** Tool execution timeout in milliseconds (3 minutes) */
export const TOOL_TIMEOUT_MS = 3 * 60 * 1000;

export const SHELL_COMMAND_TIMEOUT_MINUTES = 15;

/**
 * Ceiling on one shell command: the executor deadline, the default, and the schema maximum, which
 * must be one number. Allowed to ask for more, a caller gets the executor's interrupt — same
 * wait, but the partial output dropped. Longer waits are `register_trigger`'s job.
 */
export const SHELL_COMMAND_MAX_TIMEOUT_MS = SHELL_COMMAND_TIMEOUT_MINUTES * 60 * 1000;

/** Floor on `wait_for`'s poll interval; each check is a process spawn. */
export const WAIT_FOR_MIN_INTERVAL_MS = 250;

export const WAIT_FOR_DEFAULT_INTERVAL_MS = 5_000;

/**
 * Budget for the one check `wait_for` runs before handing off to the background, so the call
 * still returns at once while the agent sees what its condition observes right away.
 */
export const WAIT_FOR_FIRST_CHECK_TIMEOUT_MS = 5_000;

/**
 * Conversations each agent keeps in its live history when
 * `history.maxConversationsPerAgent` is unset.
 *
 * Saves are LRU (an updated conversation moves to the front), so this bounds
 * how many distinct conversations an agent keeps at hand; older ones are
 * archived, not deleted. Headless bridges (`jazz run --conversation`) keep one
 * conversation per external chat, so the limit must comfortably exceed the
 * number of concurrently active chats.
 */
export const MAX_CONVERSATION_HISTORY_PER_AGENT = 100;

/** Default maximum age for workflow catch-up runs in seconds (24 hours) */
export const DEFAULT_MAX_CATCH_UP_AGE_SECONDS = 60 * 60 * 24;

/** Default maximum number of LLM API retries on transient failures */
export const DEFAULT_MAX_LLM_RETRIES = 10;

/** AI SDK internal retries are disabled — Jazz retries via Effect.retry instead. */
export const AI_SDK_MAX_RETRIES = 0;

/**
 * Backstop on the AI SDK's multi-step loop inside a single completion call.
 * Not Jazz's agent loop — must not follow `maxIterations` from app config.
 */
export const AI_SDK_MAX_STEPS = 20;

/** Maximum delay between LLM retry attempts in seconds (caps exponential backoff) */
export const MAX_RETRY_DELAY_SECONDS = 30;

/** Total timeout for an LLM completion call, including all retries and backoff delays (15 min covers slow reasoning models) */
export const LLM_TIMEOUT_SECONDS = 900;

/** Show a slow-model hint if a single LLM attempt stays in flight this long without finishing */
export const LLM_SLOW_MODEL_HINT_SECONDS = 45;

export const HTTP_USER_AGENT = "Jazz/1.0 (https://github.com/lvndry/jazz)";
// A current desktop Chrome string: many sites serve a degraded page, or none, to a UA they read
// as stale or non-browser. Bump this as browser versions move on.
export const WEB_FETCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
