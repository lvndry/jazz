/**
 * Whether a process recorded by pid (a lock holder, a run's owner) is still running.
 */
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
