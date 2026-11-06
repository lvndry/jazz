/**
 * Why a run was stopped before it finished, recorded where the stop is issued so a consumer
 * branches on it instead of inferring it from the shape of the outcome.
 *
 * - `user`: the person at the terminal pressed Esc or Ctrl+C.
 * - `parent`: a supervising run cancelled this one (a parent stopping its sub-agents).
 * - `deadline`: a wall-clock budget (`jazz run --timeout`) expired.
 * - `shutdown`: the process running it exited: a SIGINT/SIGTERM shutdown, a daemon stop, a
 *   crash or a restart.
 */
export type CancelCause = "user" | "parent" | "deadline" | "shutdown";
