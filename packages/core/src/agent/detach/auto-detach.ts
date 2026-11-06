/**
 * Automatic promotion of a slow foreground shell command to a background call, and the record of
 * every call running detached.
 *
 * A detached call keeps its tool fiber (and so its process group) alive in this process; the
 * result reaches the conversation through `onDetachedToolComplete`. Nothing here re-runs a
 * command, and nothing outlives the process: {@link DetachedCallTracker.stopAll} ends every
 * entry when the chat does.
 */
import { Effect } from "effect";

/**
 * How long a foreground `execute_command` runs, counted from when it starts executing (not from
 * its approval prompt), before an attended run moves it to the background. Ordinary builds, test
 * runs and installs finish well inside it, so they never detach; the commands worth detaching
 * are the ones local logs show running into their caps, the shortest of which was 60 s. 45 s
 * leaves a command that sets a 60 s timeout a real stretch of background life instead of
 * detaching at the instant its own cap kills it.
 */
export const AUTO_DETACH_THRESHOLD_MS = 45_000;

/**
 * How many auto-detached commands may run at once. Each one is a live process group and a
 * pending message the model must keep track of; past this the model is better served by a
 * foreground wait, which also keeps it from fanning out unbounded long-running work.
 */
export const AUTO_DETACH_MAX_CONCURRENT = 3;

/**
 * The most of each output stream a detached command's late result carries: enough for a test
 * runner's failure summary or a build's last error, bounded so a chatty command cannot flood the
 * next turn's context.
 */
export const DETACHED_OUTPUT_TAIL_CHARS = 2_000;

export type DetachOrigin = "auto" | "user";

export interface DetachedCallEntry {
  readonly toolCallId: string;
  readonly toolName: string;
  /** What a person recognizes the call by: the command line for a shell command. */
  readonly description: string;
  /** `auto` for a call moved at the threshold, `user` for one moved with Ctrl+B. */
  readonly origin: DetachOrigin;
  readonly startedAt: number;
  /** Ends the call; resolves once its process group has stopped. */
  readonly stop: Effect.Effect<void>;
}

export interface DetachedCallTracker {
  /** Records a running detached call; the returned function removes it. */
  readonly register: (entry: DetachedCallEntry) => () => void;
  readonly running: () => readonly DetachedCallEntry[];
  /** Calls moved at the threshold that are still running. */
  readonly countAuto: () => number;
  /** Atomically claims capacity until ownership transfers or the attempt ends. */
  readonly reserveAuto: (limit: number) => (() => void) | undefined;
  /** Stops every running detached call. */
  readonly stopAll: () => Effect.Effect<void>;
}

export function createDetachedCallTracker(): DetachedCallTracker {
  const entries = new Set<DetachedCallEntry>();
  let reserved = 0;
  const countAuto = () => {
    let count = reserved;
    for (const entry of entries) {
      if (entry.origin === "auto") {
        count += 1;
      }
    }
    return count;
  };
  return {
    register: (entry) => {
      entries.add(entry);
      return () => {
        entries.delete(entry);
      };
    },
    running: () => [...entries],
    countAuto,
    reserveAuto: (limit) => {
      if (countAuto() >= limit) {
        return undefined;
      }
      reserved += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          reserved -= 1;
        }
      };
    },
    stopAll: () =>
      Effect.forEach([...entries], (entry) => entry.stop, {
        concurrency: "unbounded",
        discard: true,
      }),
  };
}

/** The detached calls of this process: one chat, whatever its turns and agents. */
export const processDetachedCalls: DetachedCallTracker = createDetachedCallTracker();

/** What an attended run carries to move slow shell commands to the background. */
export interface AutoDetachPolicy {
  readonly thresholdMs: number;
  readonly maxConcurrent: number;
  readonly tracker: DetachedCallTracker;
}

export const defaultAutoDetachPolicy: AutoDetachPolicy = {
  thresholdMs: AUTO_DETACH_THRESHOLD_MS,
  maxConcurrent: AUTO_DETACH_MAX_CONCURRENT,
  tracker: processDetachedCalls,
};

/**
 * The policy a run carries, or undefined when it keeps today's foreground wait and hard cap. A
 * late result needs a person at the terminal to read it (`attended`), a chat that delivers it
 * (`receivesLateResults`), and a run that is not a sub-agent's.
 */
export function autoDetachPolicyFor(run: {
  readonly attended: boolean;
  readonly receivesLateResults: boolean;
  readonly internal: boolean;
}): AutoDetachPolicy | undefined {
  return run.attended && run.receivesLateResults && !run.internal
    ? defaultAutoDetachPolicy
    : undefined;
}
