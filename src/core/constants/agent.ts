/** Maximum number of agent iteration steps per run */
export const MAX_AGENT_STEPS = 50;

/** Maximum number of tools that can execute concurrently */
export const MAX_CONCURRENT_TOOLS = 10;

/** Tool execution timeout in milliseconds (3 minutes) */
export const TOOL_TIMEOUT_MS = 3 * 60 * 1000;

/** Maximum number of workflow run history records to keep */
export const MAX_RUN_HISTORY_RECORDS = 100;

/** Default maximum age for workflow catch-up runs in seconds (24 hours) */
export const DEFAULT_MAX_CATCH_UP_AGE_SECONDS = 60 * 60 * 24;

/** File lock timeout in milliseconds (30 seconds) */
export const FILE_LOCK_TIMEOUT_MS = 30 * 1000;

/** File lock max retries */
export const FILE_LOCK_MAX_RETRIES = 10;

/** File lock retry delay in milliseconds */
export const FILE_LOCK_RETRY_DELAY_MS = 100;
