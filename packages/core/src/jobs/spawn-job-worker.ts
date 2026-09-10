/**
 * @fileoverview Detached worker for a freshly enqueued batch, so a batch runs with no daemon.
 *
 * Not a one-shot launchd/`at` job like wake triggers use: those schedule a future instant, and
 * launchd's minute resolution can neither start now nor express a two-second retry backoff.
 * Detached so the worker outlives the turn that enqueued it; `runDueJobs` stays the net for a
 * worker killed mid-flight.
 */
import { spawn } from "node:child_process";
import { Effect } from "effect";
import { getJazzSchedulerInvocation } from "@/core/utils/runtime";

export interface SpawnJobWorkerResult {
  readonly spawned: boolean;
  /** Why no worker started, for the caller to pass on. Absent when one did. */
  readonly reason?: string;
}

/**
 * Start a detached `jazz job run` for this agent. Never fails: a batch that could not get a worker
 * is still a valid enqueued batch that the daemon's ticker may yet pick up, so the caller is told
 * what happened rather than having the enqueue itself rejected.
 */
export function spawnJobWorker(agentId: string): Effect.Effect<SpawnJobWorkerResult> {
  return Effect.gen(function* () {
    const invocation = yield* getJazzSchedulerInvocation();
    const [executable, ...leadingArgs] = invocation;
    if (executable === undefined) {
      return { spawned: false, reason: "Could not determine how to invoke jazz on this machine." };
    }

    return yield* Effect.sync(() => {
      try {
        const child = spawn(
          executable,
          [...leadingArgs, "--output", "quiet", "job", "run", "--agent", agentId],
          { detached: true, stdio: "ignore" },
        );
        child.unref();
        return { spawned: true } satisfies SpawnJobWorkerResult;
      } catch (error) {
        return {
          spawned: false,
          reason: error instanceof Error ? error.message : String(error),
        } satisfies SpawnJobWorkerResult;
      }
    });
  });
}
