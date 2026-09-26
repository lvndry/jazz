/**
 * Cross-process mutex for file stores whose read-modify-write must not interleave.
 *
 * The lock is a directory created exclusively and stamped with its holder (`owner.json`: pid,
 * host, and a per-acquisition token). A lock is reclaimed when its holder is a dead process on
 * this host, or when it has carried no readable holder for longer than `staleMs` (a crash
 * between creating the directory and stamping it). A live holder, or one on another host, is
 * never stolen. Reclaiming renames the lock aside before deleting it, and release deletes it
 * only while it still carries this acquisition's token, so a reclaimed-and-reacquired lock is
 * never removed by its previous holder.
 */

import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { hostname } from "node:os";
import * as path from "node:path";
import { isRecord } from "@jazz/core/utils/is-record";
import { isLocalOwnerGone } from "@jazz/core/utils/process";

const HOLDER_FILE = "owner.json";

export interface FileLockOptions {
  /** How long a lock with no readable holder is trusted to be mid-acquisition. */
  readonly staleMs?: number;
  readonly maxWaitMs?: number;
  readonly retryDelayMs?: number;
  readonly timeoutError?: (lockDirectory: string) => Error;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 25;

interface LockHolder {
  readonly pid: number;
  readonly host: string;
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

async function isStale(lockDirectory: string, staleMs: number): Promise<boolean> {
  const stats = await nodeFs.stat(lockDirectory).catch(() => undefined);
  if (stats === undefined) {
    return true;
  }
  const holder = await readHolder(lockDirectory);
  if (holder !== undefined) {
    return isLocalOwnerGone(holder);
  }
  return Date.now() - stats.mtimeMs > staleMs;
}

async function removeStaleLock(lockDirectory: string): Promise<void> {
  const quarantineDirectory = `${lockDirectory}.stale-${randomUUID()}`;
  try {
    await nodeFs.rename(lockDirectory, quarantineDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  await nodeFs.rm(quarantineDirectory, { recursive: true, force: true }).catch(() => undefined);
}

/** Acquire the lock, creating its parent directory first, and return its release. */
export async function acquireFileLock(
  lockDirectory: string,
  options: FileLockOptions = {},
): Promise<() => Promise<void>> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const deadline = Date.now() + (options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const token = randomUUID();
  const holder: LockHolder = { pid: process.pid, host: hostname(), token };
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
        const current = await readHolder(lockDirectory);
        if (current?.token === token) {
          await nodeFs.rm(lockDirectory, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (await isStale(lockDirectory, staleMs)) {
        await removeStaleLock(lockDirectory);
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
