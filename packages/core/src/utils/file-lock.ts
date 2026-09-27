/**
 * Cross-process mutex for file stores whose read-modify-write must not interleave. It is the
 * one lock implementation in Jazz: `withLock` in `storage.ts` is this lock seen from Effect.
 *
 * The lock is a directory created exclusively and stamped with its holder (`owner.json`: pid,
 * host, process start time, and a per-acquisition token). A waiter reclaims the lock when:
 * - its holder is a dead or reused process on this host (checked by pid and start time, so a
 *   laptop that slept mid-section keeps its lock: the holder is still alive when it wakes);
 * - it has carried no readable holder for longer than `staleMs` (a crash between creating the
 *   directory and stamping it);
 * - its holder is on another host, where liveness cannot be checked, and it has been held
 *   longer than `maxHoldMs`.
 * A live holder on this host is never reclaimed, however long it holds the lock.
 *
 * Reclaiming and releasing both happen under a short-lived guard directory: a reclaimer
 * re-checks staleness while holding it, so two waiters that both saw a dead holder cannot take
 * turns removing each other's fresh lock, and a release removes the lock only while it still
 * carries this acquisition's token.
 *
 * Usage: `await withFileLock(path, async () => { read; check; write })`, or
 * `const release = await acquireFileLock(path)` when the hold spans several calls.
 */

import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { parentOwnerWhenRoot } from "@/core/utils/durable-file";
import { isRecord } from "@/core/utils/is-record";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "@/core/utils/private-mode";
import { currentProcessOwner, localOwnerStatus } from "@/core/utils/process";

const HOLDER_FILE = "owner.json";

export interface FileLockOptions {
  /** How long a lock with no readable holder is trusted to be mid-acquisition. */
  readonly staleMs?: number;
  /** How long a holder on another host may keep the lock before it is presumed stuck. */
  readonly maxHoldMs?: number;
  /** How long to wait for a live holder before failing. */
  readonly maxWaitMs?: number;
  readonly retryDelayMs?: number;
  readonly timeoutError?: (lockDirectory: string) => Error;
}

/** Creating the directory and stamping it are two syscalls; ten seconds unstamped is a crash. */
const DEFAULT_STALE_MS = 10_000;
/** Critical sections are a read, a check, and a write; ten minutes is a stuck remote holder. */
const DEFAULT_MAX_HOLD_MS = 10 * 60_000;
/** The guard covers one stat, one read, and one removal; older than this, its holder died. */
const GUARD_STALE_MS = 10_000;
/** Headroom on top of the slowest crash recovery, for a live holder's ordinary hold time. */
const RECOVERY_MARGIN_MS = 10_000;
/**
 * How long a waiter keeps trying by default. A crash can leave an unstamped lock (reclaimed
 * after `DEFAULT_STALE_MS`) behind a dead guard (removed after `GUARD_STALE_MS`), so the budget
 * covers both in sequence plus a margin: a write that starts right after a crash waits out the
 * recovery instead of failing.
 */
export const FILE_LOCK_MAX_WAIT_MS = DEFAULT_STALE_MS + GUARD_STALE_MS + RECOVERY_MARGIN_MS;
const DEFAULT_RETRY_DELAY_MS = 25;
/**
 * Checking a holder's start time spawns `ps` (synchronously), so a waiter re-checks one live
 * holder process at most this often, whichever of its locks it is waiting on, instead of on
 * every retry. A holder in this same process is never checked: it is alive.
 */
const LIVENESS_RECHECK_MS = 1_000;

interface LockHolder {
  readonly pid: number;
  readonly host: string;
  readonly startedAt?: number;
  readonly token: string;
}

async function readHolder(lockDirectory: string): Promise<LockHolder | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await nodeFs.readFile(path.join(lockDirectory, HOLDER_FILE), "utf8"),
    );
    if (
      !isRecord(parsed) ||
      !Number.isSafeInteger(parsed["pid"]) ||
      typeof parsed["host"] !== "string" ||
      typeof parsed["token"] !== "string"
    ) {
      return undefined;
    }
    return parsed as unknown as LockHolder;
  } catch {
    return undefined;
  }
}

/** One waiter's memory of which holder processes it has already seen alive, and when. */
type LivenessCache = Map<string, number>;

function holderProcessKey(holder: LockHolder): string {
  return `${holder.host}:${holder.pid}:${holder.startedAt ?? ""}`;
}

/** Whether the holder is this very process, which is alive by definition. */
function isThisProcess(holder: LockHolder): boolean {
  const self = currentProcessOwner();
  return holder.pid === self.pid && holder.host === self.host;
}

async function isStale(
  lockDirectory: string,
  staleMs: number,
  maxHoldMs: number,
  seenAlive: LivenessCache,
): Promise<boolean> {
  const stats = await nodeFs.stat(lockDirectory).catch(() => undefined);
  if (stats === undefined) {
    return false;
  }
  const heldForMs = Date.now() - stats.mtimeMs;
  const holder = await readHolder(lockDirectory);
  if (holder === undefined) {
    return heldForMs > staleMs;
  }
  if (isThisProcess(holder)) {
    return false;
  }
  const processKey = holderProcessKey(holder);
  const lastSeenAlive = seenAlive.get(processKey);
  if (lastSeenAlive !== undefined && Date.now() - lastSeenAlive < LIVENESS_RECHECK_MS) {
    return false;
  }
  const status = localOwnerStatus(holder);
  if (status === "gone") {
    return true;
  }
  if (status === "unverifiable") {
    return heldForMs > maxHoldMs;
  }
  seenAlive.set(processKey, Date.now());
  return false;
}

/**
 * Run `operation` holding the guard for `lockDirectory`, or return false when another process
 * holds it. A guard left by a process that died is removed once it is older than its window.
 */
async function underGuard(lockDirectory: string, operation: () => Promise<void>) {
  const guard = `${lockDirectory}.guard`;
  try {
    await nodeFs.mkdir(guard, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const stats = await nodeFs.stat(guard).catch(() => undefined);
    if (stats !== undefined && Date.now() - stats.mtimeMs > GUARD_STALE_MS) {
      await nodeFs.rm(guard, { recursive: true, force: true });
    }
    return false;
  }
  try {
    await operation();
    return true;
  } finally {
    await nodeFs.rm(guard, { recursive: true, force: true });
  }
}

/** Acquire the lock, creating its parent directory first, and return its release. */
export async function acquireFileLock(
  lockDirectory: string,
  options: FileLockOptions = {},
): Promise<() => Promise<void>> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const maxHoldMs = options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const deadline = Date.now() + (options.maxWaitMs ?? FILE_LOCK_MAX_WAIT_MS);
  const token = randomUUID();
  const holder: LockHolder = { ...currentProcessOwner(), token };
  const seenAlive: LivenessCache = new Map();
  await nodeFs.mkdir(path.dirname(lockDirectory), {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  for (;;) {
    try {
      await nodeFs.mkdir(lockDirectory, { mode: PRIVATE_DIRECTORY_MODE });
      try {
        const holderFile = path.join(lockDirectory, HOLDER_FILE);
        await nodeFs.writeFile(holderFile, JSON.stringify(holder), {
          encoding: "utf8",
          flag: "wx",
          mode: PRIVATE_FILE_MODE,
        });
        const owner = await parentOwnerWhenRoot(path.dirname(lockDirectory));
        if (owner !== undefined) {
          await nodeFs.chown(lockDirectory, owner.uid, owner.gid);
          await nodeFs.chown(holderFile, owner.uid, owner.gid);
        }
      } catch (error) {
        await nodeFs.rm(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        const releaseBy = Date.now() + GUARD_STALE_MS * 2;
        for (;;) {
          const released = await underGuard(lockDirectory, async () => {
            const current = await readHolder(lockDirectory);
            if (current?.token === token) {
              await nodeFs.rm(lockDirectory, { recursive: true, force: true });
            }
          });
          if (released || Date.now() >= releaseBy) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      let reclaimed = false;
      await underGuard(lockDirectory, async () => {
        if (await isStale(lockDirectory, staleMs, maxHoldMs, seenAlive)) {
          await nodeFs.rm(lockDirectory, { recursive: true, force: true });
          reclaimed = true;
        }
      });
      if (reclaimed) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw (
          options.timeoutError?.(lockDirectory) ??
          new Error(`Timed out waiting for the lock at "${lockDirectory}".`, { cause: error })
        );
      }
      const jitterMs = Math.random() * (retryDelayMs / 2);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs + jitterMs));
    }
  }
}

/** Run `operation` while holding the lock at `lockDirectory`. */
export async function withFileLock<A>(
  lockDirectory: string,
  operation: () => Promise<A>,
  options?: FileLockOptions,
): Promise<A> {
  const release = await acquireFileLock(lockDirectory, options);
  try {
    return await operation();
  } finally {
    await release();
  }
}
