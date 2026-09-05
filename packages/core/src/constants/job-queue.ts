/**
 * Ceilings mirror wake-triggers.ts's reasoning: a model that talks itself into enqueueing
 * without bound should hit a wall long before it burns meaningful spend or overwhelms the
 * daemon's worker pool.
 */
export const MAX_JOBS_PER_BATCH = 20;

/** Maximum number of batches with at least one non-terminal job, per agent. */
export const MAX_ACTIVE_BATCHES_PER_AGENT = 5;

/** Maximum length, in characters, of a single job's shell command. */
export const JOB_COMMAND_MAX_LENGTH = 4000;

/** Maximum length, in characters, of a batch's reason (shown via list_jobs, not sent to the model). */
export const JOB_REASON_MAX_LENGTH = 300;

export const DEFAULT_CONCURRENCY_CAP = 3;
export const MAX_CONCURRENCY_CAP = 10;

export const DEFAULT_MAX_ATTEMPTS = 1;
export const MAX_MAX_ATTEMPTS = 5;

export const DEFAULT_BACKOFF_INITIAL_MS = 2_000;
export const DEFAULT_BACKOFF_MAX_MS = 5 * 60 * 1000;

/** Default per-job shell execution timeout. */
export const DEFAULT_JOB_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * A job claimed by a worker that never reaches a terminal state within this window (worker
 * crashed, process killed) becomes claimable again. Must exceed DEFAULT_JOB_TIMEOUT_MS so a
 * merely slow job is never reclaimed out from under its own worker.
 */
export const JOB_LEASE_TIMEOUT_MS = DEFAULT_JOB_TIMEOUT_MS + 2 * 60 * 1000;

/** How many jobs one daemon tick claims per agent, across that agent's active batches. */
export const WORKER_POOL_SIZE = 4;

/**
 * How much of one job's output is quoted back to the agent. A tail, because that is where a
 * command's verdict lives. Caps one wake message at roughly `MAX_JOBS_PER_BATCH` times this,
 * since a job reports one stream or the other.
 */
export const JOB_OUTPUT_TAIL_CHARS = 2000;
