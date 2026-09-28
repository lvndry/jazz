/**
 * @fileoverview Stopping a bridge without dropping people on the floor.
 *
 * `docker stop`, a deploy and the hourly auto-update all send SIGTERM. A bridge that simply
 * exits leaves every run it started killed mid-answer and nobody told. So on SIGTERM or
 * SIGINT: stop taking messages, tell everyone with a run in flight that it was stopped,
 * cancel those runs, give them a moment to wind down, and exit.
 */

import type { TurnRunner } from "./turn";

/**
 * How long the runs a shutdown cancelled get to exit. Docker's own stop timeout is ten
 * seconds before it kills the container, so this stays under it.
 */
const SHUTDOWN_GRACE_MS = 8_000;

export interface ShutdownOptions {
  readonly runner: TurnRunner;
  /** Stop receiving: close the poll loop, the socket, the watcher. */
  readonly stopIntake: () => void | Promise<void>;
  /** Anything to close after the runs, like an HTTP server. */
  readonly afterDrain?: () => void | Promise<void>;
}

/** Install the SIGTERM/SIGINT handlers. A second signal exits at once. */
export function installShutdown(options: ShutdownOptions): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    console.error(`${signal} received: stopping intake and draining runs.`);
    void (async () => {
      try {
        await options.stopIntake();
        await options.runner.shutdown(SHUTDOWN_GRACE_MS);
        await options.afterDrain?.();
      } catch (error) {
        console.error(`Shutdown did not finish cleanly: ${String(error)}`);
      }
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
