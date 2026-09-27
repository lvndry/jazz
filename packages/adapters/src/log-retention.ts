/**
 * Keeps the logs directory bounded: rotates files that grew too large, deletes files nobody
 * wrote to for longer than the retention window, and deletes the oldest files once the whole
 * directory is over its size cap.
 *
 * Everything that writes into `logs/` benefits without knowing about this: the logger's
 * `jazz.log` and per-conversation logs, workflow stdout and stderr that launchd or cron append
 * to, the background daemon's `daemon.log`, and the per-item logs one-shot reminders and wake
 * triggers leave behind in `logs/one-shot/`. Those one-shot logs hold one firing each, so they
 * are kept for a day rather than the whole retention window.
 *
 * The sweep is cheap but not free (a directory listing and a stat per file), so
 * `pruneLogsDirectoryIfDue` runs it at most once per `LOG_PRUNE_INTERVAL_MS` per directory,
 * across processes, using the modification time of a stamp file in the directory.
 *
 * Rotation renames `name` to `name.1`, `name.1` to `name.2`, and so on, dropping the oldest
 * generation. A file that another process holds open for appending (the daemon's stdout) is
 * rotated by copying it aside and truncating it in place instead, because a rename would leave
 * that process writing into the rotated copy.
 */

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { ONE_SHOT_LOGS_DIRECTORY_NAME } from "@jazz/core/utils/paths";

const BYTES_PER_MEGABYTE = 1024 * 1024;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** Days a log file is kept after its last write when `logging.retentionDays` is unset. */
export const DEFAULT_LOG_RETENTION_DAYS = 14;

/** Size cap for the whole logs directory when `logging.maxTotalSizeMB` is unset. */
export const DEFAULT_MAX_LOGS_TOTAL_SIZE_MB = 200;

/** A log file larger than this is rotated. Large enough for weeks of a busy `jazz.log`. */
export const MAX_LOG_FILE_BYTES = 10 * BYTES_PER_MEGABYTE;

/** Rotated copies kept per log file (`name.1` through `name.N`). */
export const ROTATED_LOG_GENERATIONS = 2;

/** A one-shot job's log records a single firing; a day is enough to look at it. */
export const ONE_SHOT_LOG_RETENTION_MS = MILLISECONDS_PER_DAY;

/** How often one directory is swept. */
export const LOG_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Stamp file whose modification time records the last sweep. */
const PRUNE_STAMP_FILENAME = ".pruned-at";

/** Files held open for appending by a long-lived process, rotated by copy and truncate. */
const HELD_OPEN_LOG_FILENAMES: ReadonlySet<string> = new Set(["daemon.log", "daemon.error.log"]);

const ROTATED_SUFFIX_PATTERN = /\.\d+$/;

export interface LogRetentionPolicy {
  readonly retentionMs: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
}

/** The policy for the configured `logging.retentionDays` and `logging.maxTotalSizeMB`. */
export function logRetentionPolicy(options?: {
  readonly retentionDays?: number | undefined;
  readonly maxTotalSizeMB?: number | undefined;
}): LogRetentionPolicy {
  return {
    retentionMs: (options?.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS) * MILLISECONDS_PER_DAY,
    maxTotalBytes: (options?.maxTotalSizeMB ?? DEFAULT_MAX_LOGS_TOTAL_SIZE_MB) * BYTES_PER_MEGABYTE,
    maxFileBytes: MAX_LOG_FILE_BYTES,
  };
}

export interface LogPruneReport {
  readonly rotated: readonly string[];
  readonly deleted: readonly string[];
}

interface LogFile {
  readonly filePath: string;
  readonly name: string;
  readonly size: number;
  readonly modifiedAtMs: number;
}

async function listLogFiles(directory: string): Promise<LogFile[]> {
  let names: string[];
  try {
    names = await nodeFs.readdir(directory);
  } catch {
    return [];
  }
  const files: LogFile[] = [];
  for (const name of names) {
    if (name === PRUNE_STAMP_FILENAME) {
      continue;
    }
    const filePath = path.join(directory, name);
    try {
      const info = await nodeFs.lstat(filePath);
      if (!info.isFile()) {
        continue;
      }
      files.push({ filePath, name, size: info.size, modifiedAtMs: info.mtimeMs });
    } catch {
      continue;
    }
  }
  return files;
}

/** Path of a rotated generation of `filePath`, e.g. `jazz.log.1`. */
export function rotatedLogPath(filePath: string, generation: number): string {
  return `${filePath}.${generation}`;
}

/**
 * Rotates one log file, keeping `generations` older copies. `heldOpen` rotates by copy and
 * truncate so a process appending through an open descriptor keeps writing to `filePath`.
 */
export async function rotateLogFile(
  filePath: string,
  options: { readonly generations: number; readonly heldOpen: boolean },
): Promise<void> {
  await nodeFs.rm(rotatedLogPath(filePath, options.generations), { force: true });
  for (let generation = options.generations - 1; generation >= 1; generation--) {
    await nodeFs
      .rename(rotatedLogPath(filePath, generation), rotatedLogPath(filePath, generation + 1))
      .catch(() => undefined);
  }
  if (options.heldOpen) {
    await nodeFs.copyFile(filePath, rotatedLogPath(filePath, 1));
    await nodeFs.truncate(filePath, 0);
    return;
  }
  await nodeFs.rename(filePath, rotatedLogPath(filePath, 1));
}

async function deleteFiles(files: readonly LogFile[], deleted: string[]): Promise<void> {
  for (const file of files) {
    try {
      await nodeFs.rm(file.filePath, { force: true });
      deleted.push(file.filePath);
    } catch {
      continue;
    }
  }
}

/**
 * One sweep of `directory` and its `one-shot/` subdirectory. Other subdirectories are left
 * alone: they belong to whoever created them.
 */
export async function pruneLogsDirectory(
  directory: string,
  policy: LogRetentionPolicy,
  now: number = Date.now(),
): Promise<LogPruneReport> {
  const rotated: string[] = [];
  const deleted: string[] = [];

  const oneShotFiles = await listLogFiles(path.join(directory, ONE_SHOT_LOGS_DIRECTORY_NAME));
  await deleteFiles(
    oneShotFiles.filter((file) => now - file.modifiedAtMs > ONE_SHOT_LOG_RETENTION_MS),
    deleted,
  );

  const expired = (file: LogFile) => now - file.modifiedAtMs > policy.retentionMs;
  const initial = await listLogFiles(directory);
  await deleteFiles(initial.filter(expired), deleted);

  for (const file of initial) {
    if (expired(file) || file.size <= policy.maxFileBytes) {
      continue;
    }
    if (ROTATED_SUFFIX_PATTERN.test(file.name)) {
      continue;
    }
    try {
      await rotateLogFile(file.filePath, {
        generations: ROTATED_LOG_GENERATIONS,
        heldOpen: HELD_OPEN_LOG_FILENAMES.has(file.name),
      });
      rotated.push(file.filePath);
    } catch {
      continue;
    }
  }

  const remaining = [
    ...(await listLogFiles(directory)),
    ...(await listLogFiles(path.join(directory, ONE_SHOT_LOGS_DIRECTORY_NAME))),
  ].sort((left, right) => left.modifiedAtMs - right.modifiedAtMs);
  let totalBytes = remaining.reduce((sum, file) => sum + file.size, 0);
  const overCap: LogFile[] = [];
  for (const file of remaining) {
    if (totalBytes <= policy.maxTotalBytes) {
      break;
    }
    overCap.push(file);
    totalBytes -= file.size;
  }
  await deleteFiles(overCap, deleted);

  return { rotated, deleted };
}

async function lastPrunedAtMs(directory: string): Promise<number | null> {
  try {
    return (await nodeFs.stat(path.join(directory, PRUNE_STAMP_FILENAME))).mtimeMs;
  } catch {
    return null;
  }
}

async function stampPruned(directory: string, now: number): Promise<void> {
  const stampPath = path.join(directory, PRUNE_STAMP_FILENAME);
  await nodeFs.writeFile(stampPath, "", { mode: 0o600 });
  const stampTime = new Date(now);
  await nodeFs.utimes(stampPath, stampTime, stampTime);
}

/**
 * Sweeps `directory` when the last sweep, by any process, is older than
 * `LOG_PRUNE_INTERVAL_MS`. Returns null when it was not due. Never throws: housekeeping must
 * not fail the write that triggered it.
 */
export async function pruneLogsDirectoryIfDue(
  directory: string,
  policy: LogRetentionPolicy,
  now: number = Date.now(),
): Promise<LogPruneReport | null> {
  try {
    const lastPruned = await lastPrunedAtMs(directory);
    if (lastPruned !== null && now - lastPruned < LOG_PRUNE_INTERVAL_MS) {
      return null;
    }
    await nodeFs.mkdir(directory, { recursive: true, mode: 0o700 });
    await stampPruned(directory, now);
    return await pruneLogsDirectory(directory, policy, now);
  } catch {
    return null;
  }
}
