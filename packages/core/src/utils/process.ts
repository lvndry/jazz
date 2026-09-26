/**
 * Whether a process recorded by pid (a lock holder, a run's owner) is still running.
 */
import { hostname } from "node:os";

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
 * Whether a recorded owner is known to be dead. An owner on another host is never judged from
 * here: its pid means nothing locally, so it counts as alive.
 */
export function isLocalOwnerGone(owner: { readonly pid: number; readonly host: string }): boolean {
  return owner.host === hostname() && !isProcessAlive(owner.pid);
}
