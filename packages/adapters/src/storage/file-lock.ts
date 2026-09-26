/**
 * Cross-process mutex for file stores whose read-modify-write must not interleave.
 *
 * The lock is a directory created exclusively and stamped with its holder (`owner.json`: pid,
 * host, process start time, and a per-acquisition token). A lock is reclaimed when its holder is
 * a dead or reused process on this host, when it has carried no readable holder for longer than
 * `staleMs` (a crash between creating the directory and stamping it), or when it has been held
 * longer than `maxHoldMs`, which no critical section comes near and which also frees a lock whose
 * holder is on another host. Reclaiming and releasing both happen under a short-lived guard
 * directory: a reclaimer re-checks staleness while holding it, so two waiters that both saw a
 * dead holder cannot take turns removing each other's fresh lock, and a release removes the lock
 * only while it still carries this acquisition's token.
 */

import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "@jazz/core/utils/is-record";
import { currentProcessOwner, isLocalOwnerGone } from "@jazz/core/utils/process";

const HOLDER_FILE = "owner.json";

export interface FileLockOptions {
  /** How long a lock with no readable holder is trusted to be mid-acquisition. */
  readonly staleMs?: number;
  /** How long any holder may keep the lock before it is presumed stuck and reclaimed. */
  readonly maxHoldMs?: number;
  readonly maxWaitMs?: number;
  readonly retryDelayMs?: number;
  readonly timeoutError?: (lockDirectory: string) => Error;
}

const DEFAULT_STALE_MS = 30_000;
/** Critical sections are a read, a check, and a write; ten minutes is a stuck holder. */
const DEFAULT_MAX_HOLD_MS = 10 * 60_000;
/** The guard covers one stat, one read, and one removal; older than this, its holder died. */
const GUARD_STALE_MS = 10_000;
const DEFAULT_MAX_WAIT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 25;

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

async function isStale(lockDirectory: string, staleMs: number, maxHoldMs: number) {
  const stats = await nodeFs.stat(lockDirectory).catch(() => undefined);
  if (stats === undefined) {
    return false;
  }
  const heldForMs = Date.now() - stats.mtimeMs;
  const holder = await readHolder(lockDirectory);
  if (holder !== undefined) {
    return heldForMs > maxHoldMs || isLocalOwnerGone(holder);
  }
  return heldForMs > staleMs;
}

/**
 * Run `operation` holding the guard for `lockDirectory`, or return false when another process
 * holds it. A guard left by a process that died is removed once it is older than its window.
 */
async function underGuard(lockDirectory: string, operation: () => Promise<void>) {
  const guard = `${lockDirectory}.guard`;
  try {
    await nodeFs.mkdir(guard, { mode: 0o700 });
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
  const deadline = Date.now() + (options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const token = randomUUID();
  const holder: LockHolder = { ...currentProcessOwner(), token };
  await nodeFs.mkdir(path.dirname(lockDirectory), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await nodeFs.mkdir(lockDirectory, { mode: 0o700 });
      try {
        await nodeFs.writeFile(path.join(lockDirectory, HOLDER_FILE), JSON.stringify(holder), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
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
        if (await isStale(lockDirectory, staleMs, maxHoldMs)) {
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
