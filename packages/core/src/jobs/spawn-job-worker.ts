/**
 * @fileoverview Starting a detached worker for a freshly enqueued job batch.
 *
 * A batch used to execute only from `jazz daemon`'s tick. On a machine with no daemon running,
 * `enqueue_batch` returned a batch id, the person approved commands to run unattended, and then
 * nothing ran and nothing woke them — a silent stall standing behind an approval prompt.
 *
 * Wake triggers solve their version of this with a one-shot host-scheduler job (launchd, or `at`),
 * but that mechanism schedules a future *instant*: launchd's `StartCalendarInterval` has minute
 * resolution and no year key, so asking it to run something now either misses the current minute
 * or waits up to sixty seconds for it, and a two-second retry backoff cannot be expressed at all.
 * A batch is meant to start immediately, so it gets a detached child process instead — no
 * scheduler, no resident daemon, no minute rounding.
 *
 * Detached and unreferenced on purpose: the worker has to outlive the CLI or chat turn that
 * enqueued the batch, which is the entire point of a background job. `jazz daemon`'s ticker still
 * calls `runDueJobs`, which stays the safety net for a batch whose worker is killed mid-flight.
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
