/**
 * Process helpers: whether a process recorded by pid (a lock holder, a run's owner) is still
 * running, and how to kill a spawned command together with everything it started.
 */
import type { ChildProcess } from "node:child_process";
import { hostname } from "node:os";

/** A process that holds something: a lock, a cycle, a working run. */
export interface ProcessOwner {
  readonly pid: number;
  readonly host: string;
  /**
   * When the process started, in epoch milliseconds. A pid is reused once its process exits,
   * so a live pid only proves the owner alive when its start time matches this.
   */
  readonly startedAt?: number;
}

/**
 * `ps` reports start times to the second, and this process's own figure comes from its
 * uptime; the two can disagree by a little over a second for the same process.
 */
const START_TIME_TOLERANCE_MS = 3_000;

/** This process as an owner record. */
export function currentProcessOwner(): ProcessOwner {
  return {
    pid: process.pid,
    host: hostname(),
    startedAt: Math.round(Date.now() - process.uptime() * 1000),
  };
}

/**
 * `kill(pid, 0)` sends no signal; it only asks whether the pid is addressable. EPERM means the
 * process exists but belongs to another user, so it is alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * When a local process started, from `ps`, or undefined when it cannot be read. `ps` prints a
 * local time without a zone, so it runs in UTC and the result is read as UTC, whatever zone
 * this process's own dates use.
 */
function processStartedAt(pid: number): number | undefined {
  try {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, TZ: "UTC" },
    });
    const started = Date.parse(`${result.stdout.toString().trim()} UTC`);
    return result.exitCode === 0 && Number.isFinite(started) ? started : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What can be known about a recorded owner from this machine. An owner on another host is
 * `unverifiable`: its pid means nothing here, so it is neither trusted as running nor declared
 * dead. A live pid whose start time differs from the record's belongs to a newer process.
 */
export function localOwnerStatus(owner: ProcessOwner): "alive" | "gone" | "unverifiable" {
  if (owner.host !== hostname()) {
    return "unverifiable";
  }
  if (!isProcessAlive(owner.pid)) {
    return "gone";
  }
  if (owner.startedAt === undefined) {
    return "alive";
  }
  const started = processStartedAt(owner.pid);
  if (started === undefined) {
    return "unverifiable";
  }
  return Math.abs(started - owner.startedAt) <= START_TIME_TOLERANCE_MS ? "alive" : "gone";
}

/**
 * Whether a recorded owner is known to be dead. An owner on another host is never judged from
 * here, so it counts as alive.
 */
export function isLocalOwnerGone(owner: ProcessOwner): boolean {
  return localOwnerStatus(owner) === "gone";
}

/**
 * How long a spawned command's output may keep arriving after the process exits before its
 * caller returns anyway. Pipe data lands a few milliseconds after `exit`; a pipe still open past
 * this belongs to a background job the command started, which can hold it for as long as it runs.
 */
export const PIPE_DRAIN_GRACE_MS = 200;

/**
 * How long a stopped command gets between SIGTERM and SIGKILL. Long enough for a process that
 * handles SIGTERM to finish what it is doing safely: flush a file it is writing, remove its temp
 * files, let git drop `index.lock`, close a database. Short enough that `--timeout`, SIGTERM and a
 * run deadline still end promptly, well inside the 15s a chat bridge waits past its own timeout
 * before killing the run.
 */
export const PROCESS_TERMINATION_GRACE_MS = 3_000;

/** Commands started by tools and not yet exited, so a forced exit can take them down with it. */
const trackedProcesses = new Set<ChildProcess>();

/**
 * Remember a spawned command until it exits. Commands run in their own process group, so nothing
 * else stops them when Jazz exits; {@link killTrackedProcesses} does, on a forced exit.
 */
export function trackChildProcess(child: ChildProcess): void {
  trackedProcesses.add(child);
  child.once("exit", () => {
    trackedProcesses.delete(child);
  });
}

/** SIGKILL every tracked command's process group at once: the second-signal, force-exit path. */
export function killTrackedProcesses(): void {
  for (const child of trackedProcesses) {
    signalProcessGroup(child, "SIGKILL");
  }
  trackedProcesses.clear();
}

/**
 * Signal a child and, when it leads one (`detached: true`), its whole process group: the shell
 * and every process the command started (a pipeline, a backgrounded `cmd &`, a script's own
 * children). Signalling only the child's pid leaves those grandchildren running. Falls back to
 * the child alone when it leads no group or the platform has no process groups.
 */
export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // No such group: signal the child directly below.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

/**
 * Stop a command gracefully: SIGTERM to its process group, then SIGKILL once `graceMs` has passed
 * without it exiting. When it exits on its own after SIGTERM, anything left in its group is
 * SIGKILLed, since a process still there has already ignored the request to stop. Resolves when
 * the command is gone. Immediate SIGKILL is only for a forced exit ({@link killTrackedProcesses}).
 */
export function terminateProcessGroup(
  child: ChildProcess,
  graceMs: number = PROCESS_TERMINATION_GRACE_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      child.off("exit", onExit);
      signalProcessGroup(child, "SIGKILL");
      resolve();
    }, graceMs);
    function onExit(): void {
      clearTimeout(forceTimer);
      signalProcessGroup(child, "SIGKILL");
      resolve();
    }
    child.once("exit", onExit);
    signalProcessGroup(child, "SIGTERM");
  });
}
