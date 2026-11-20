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
import { toError } from "@/core/utils/errors";
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
  return spawnDetachedJazz(["--output", "quiet", "job", "run", "--agent", agentId]);
}

/** A detached child's error after it started belongs to the child, never to this process. */
function ignoreLaterError(): void {}

/** Start `jazz <args>` detached from this process, so it outlives it. Never fails. */
export function spawnDetachedJazz(args: readonly string[]): Effect.Effect<SpawnJobWorkerResult> {
  return Effect.gen(function* () {
    const invocation = yield* getJazzSchedulerInvocation();
    const [executable, ...leadingArgs] = invocation;
    if (executable === undefined) {
      return { spawned: false, reason: "Could not determine how to invoke jazz on this machine." };
    }
    return yield* spawnDetachedCommand(executable, [...leadingArgs, ...args]);
  });
}

/**
 * Start `executable` detached from this process, so it outlives it. Never fails: a launch that
 * fails, including one `spawn` reports asynchronously (a missing executable), comes back as
 * `spawned: false` with the reason.
 */
export function spawnDetachedCommand(
  executable: string,
  args: readonly string[],
): Effect.Effect<SpawnJobWorkerResult> {
  return Effect.callback<SpawnJobWorkerResult>((resume) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], { detached: true, stdio: "ignore" });
    } catch (error) {
      resume(Effect.succeed({ spawned: false, reason: toError(error).message }));
      return;
    }
    const onSpawn = () => {
      child.off("error", onLaunchError);
      child.on("error", ignoreLaterError);
      child.unref();
      resume(Effect.succeed({ spawned: true }));
    };
    const onLaunchError = (error: Error) => {
      child.off("spawn", onSpawn);
      resume(Effect.succeed({ spawned: false, reason: error.message }));
    };
    child.once("spawn", onSpawn);
    child.once("error", onLaunchError);
  });
}
