/** Default maximum number of agent iteration steps per run */
export const DEFAULT_MAX_ITERATIONS = 80;

/** Maximum number of tools that can execute concurrently */
export const MAX_CONCURRENT_TOOLS = 10;

/** Tool execution timeout in milliseconds (3 minutes) */
export const TOOL_TIMEOUT_MS = 3 * 60 * 1000;

/** Maximum number of workflow run history records to keep */
export const MAX_RUN_HISTORY_RECORDS = 100;

/** Maximum number of conversation history records to keep per agent */
export const MAX_CONVERSATION_HISTORY_PER_AGENT = 5;

/** Default maximum age for workflow catch-up runs in seconds (24 hours) */
export const DEFAULT_MAX_CATCH_UP_AGE_SECONDS = 60 * 60 * 24;

/** File lock timeout in milliseconds (30 seconds) */
export const FILE_LOCK_TIMEOUT_MS = 30 * 1000;

/** File lock max retries */
export const FILE_LOCK_MAX_RETRIES = 10;

/** File lock retry delay in milliseconds */
export const FILE_LOCK_RETRY_DELAY_MS = 100;

/** Default maximum number of LLM API retries on transient failures */
export const DEFAULT_MAX_LLM_RETRIES = 10;

/** Maximum delay between LLM retry attempts in seconds (caps exponential backoff) */
export const MAX_RETRY_DELAY_SECONDS = 30;

/** Total timeout for an LLM completion call, including all retries and backoff delays (15 min covers slow reasoning models) */
export const LLM_TIMEOUT_SECONDS = 900;

/** Show a slow-model hint if a single LLM attempt stays in flight this long without finishing */
export const LLM_SLOW_MODEL_HINT_SECONDS = 45;

export const HTTP_USER_AGENT = "Jazz/1.0 (https://github.com/lvndry/jazz)";
export const WEB_FETCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
