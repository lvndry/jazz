/**
 * What lets one run, and only one, drive this machine, and lets the operator stop it.
 *
 * - The lock is a directory under `$JAZZ_HOME/computer`, taken without waiting. A second run
 *   that wants the desktop is told who holds it. A lock left by a process that died is reclaimed
 *   by the next run, so a crash never leaves the desktop unreachable.
 * - `jazz computer stop` does not need the run's cooperation. It records a stop request that the
 *   session checks before every action, and signals the driver process so an action already in
 *   flight fails at once.
 */

import { readFile, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { writeFileDurably, writeJsonFileDurably } from "@/core/utils/durable-file";
import { acquireFileLock } from "@/core/utils/file-lock";
import { isRecord } from "@/core/utils/is-record";
import { isProcessAlive } from "@/core/utils/process";
import { computerDirectory } from "./grants";

function lockPath(): string {
  return path.join(computerDirectory(), "run.lock");
}

function sessionInfoPath(): string {
  return path.join(computerDirectory(), "session.json");
}

function stopFlagPath(): string {
  return path.join(computerDirectory(), "stop");
}

export const LOCK_HELD_MESSAGE =
  "Another Jazz run is already controlling this computer. Wait for it to finish, or stop it with `jazz computer stop`.";

/** Take the machine-wide computer lock without waiting, or fail with why it is unavailable. */
export function acquireComputerLock(): Promise<() => Promise<void>> {
  return acquireFileLock(lockPath(), {
    maxWaitMs: 0,
    timeoutError: () => new Error(LOCK_HELD_MESSAGE),
  });
}

export interface ComputerSessionInfo {
  readonly pid: number;
  readonly driverPid: number | null;
  readonly conversationId: string | undefined;
  readonly startedAt: number;
}

export async function writeSessionInfo(info: ComputerSessionInfo): Promise<void> {
  await writeJsonFileDurably(sessionInfoPath(), info);
}

export async function clearSessionInfo(): Promise<void> {
  await rm(sessionInfoPath(), { force: true });
}

export async function readSessionInfo(): Promise<ComputerSessionInfo | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(sessionInfoPath(), "utf8"));
    if (
      !isRecord(parsed) ||
      typeof parsed["pid"] !== "number" ||
      typeof parsed["startedAt"] !== "number"
    ) {
      return undefined;
    }
    return {
      pid: parsed["pid"],
      driverPid: typeof parsed["driverPid"] === "number" ? parsed["driverPid"] : null,
      conversationId:
        typeof parsed["conversationId"] === "string" ? parsed["conversationId"] : undefined,
      startedAt: parsed["startedAt"],
    };
  } catch {
    return undefined;
  }
}

/**
 * Ask the run that holds the desktop to stop. Returns the session it asked, or undefined when
 * none was running. Safe when nothing is running: the request is cleared by the next session.
 */
export async function requestStop(): Promise<ComputerSessionInfo | undefined> {
  const session = await readSessionInfo();
  await writeFileDurably(stopFlagPath(), String(Date.now()));
  if (session?.driverPid !== null && session?.driverPid !== undefined) {
    if (isProcessAlive(session.driverPid)) {
      try {
        process.kill(session.driverPid, "SIGTERM");
      } catch {
        return session;
      }
    }
  }
  return session;
}

/** Whether a stop was requested at or after `since`, in epoch milliseconds. */
export async function stopRequestedSince(since: number): Promise<boolean> {
  try {
    return (await stat(stopFlagPath())).mtimeMs >= since;
  } catch {
    return false;
  }
}

/** Forget any earlier stop request; a new session starts without one. */
export async function clearStopRequest(): Promise<void> {
  await rm(stopFlagPath(), { force: true });
}
