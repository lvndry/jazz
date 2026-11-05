/**
 * Age-based deletion under one root directory, built to be safe to run unattended.
 *
 * Every entry is inspected with `lstat`, so a symlink is never followed: a link is itself
 * deleted (as a link) when it is old, and what it points at is never read, descended into or
 * removed. The root is canonicalized once and every directory visited is re-checked to still
 * resolve inside it before anything in it is deleted, so a directory swapped for a link
 * mid-sweep cannot lead the sweep out of the root.
 *
 * The sweep never throws. A path that cannot be inspected or removed is recorded in the result
 * and skipped. Work is bounded by `maxEntries` examined entries, and it yields to the event loop
 * every `YIELD_EVERY_ENTRIES` so a large tree cannot stall the process that started it.
 *
 * Directories the sweep emptied are removed; the root itself is kept.
 */

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";

/** Entries examined between yields to the event loop. */
export const YIELD_EVERY_ENTRIES = 64;

/** What the sweep needs to know about one entry; the subset of `fs.Stats` it reads. */
export interface SweepEntryStat {
  readonly isFile: () => boolean;
  readonly isDirectory: () => boolean;
  readonly isSymbolicLink: () => boolean;
  readonly mtimeMs: number;
  readonly size: number;
}

export interface SweepFileSystem {
  readonly lstat: (target: string) => Promise<SweepEntryStat>;
  readonly readdir: (target: string) => Promise<readonly string[]>;
  readonly realpath: (target: string) => Promise<string>;
  readonly unlink: (target: string) => Promise<void>;
  readonly rmdir: (target: string) => Promise<void>;
}

export const nodeSweepFileSystem: SweepFileSystem = {
  lstat: (target) => nodeFs.lstat(target),
  readdir: (target) => nodeFs.readdir(target),
  realpath: (target) => nodeFs.realpath(target),
  unlink: (target) => nodeFs.unlink(target),
  rmdir: (target) => nodeFs.rmdir(target),
};

export interface SweepOptions {
  readonly root: string;
  readonly now: number;
  /** Entries whose modification time is more than this many milliseconds old are deleted. */
  readonly maxAgeMs: number;
  /** Most entries examined before the sweep stops and reports `truncated`. */
  readonly maxEntries: number;
  readonly fileSystem?: SweepFileSystem;
  /** Awaited every `YIELD_EVERY_ENTRIES` entries; defaults to a macrotask turn. */
  readonly yieldToEventLoop?: () => Promise<void>;
}

export interface SweepFailure {
  readonly path: string;
  readonly operation: "lstat" | "readdir" | "realpath" | "unlink" | "rmdir" | "containment";
  readonly message: string;
}

export interface SweepResult {
  readonly examined: number;
  readonly deletedFiles: number;
  readonly deletedSymlinks: number;
  readonly prunedDirectories: number;
  readonly bytesFreed: number;
  /** True when `maxEntries` was reached before the tree was fully walked. */
  readonly truncated: boolean;
  readonly failures: readonly SweepFailure[];
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function sweepStaleFiles(options: SweepOptions): Promise<SweepResult> {
  const fileSystem = options.fileSystem ?? nodeSweepFileSystem;
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYield;
  const failures: SweepFailure[] = [];
  let examined = 0;
  let deletedFiles = 0;
  let deletedSymlinks = 0;
  let prunedDirectories = 0;
  let bytesFreed = 0;
  let truncated = false;

  const fail = (target: string, operation: SweepFailure["operation"], error: unknown): void => {
    failures.push({ path: target, operation, message: describeError(error) });
  };

  const finish = (): SweepResult => ({
    examined,
    deletedFiles,
    deletedSymlinks,
    prunedDirectories,
    bytesFreed,
    truncated,
    failures,
  });

  let canonicalRoot: string;
  try {
    canonicalRoot = await fileSystem.realpath(options.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      fail(options.root, "realpath", error);
    }
    return finish();
  }

  const isOld = (stat: SweepEntryStat): boolean => options.now - stat.mtimeMs > options.maxAgeMs;

  /** Returns true when the directory was removed. */
  const walk = async (directory: string, isRoot: boolean): Promise<boolean> => {
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await fileSystem.realpath(directory);
    } catch (error) {
      fail(directory, "realpath", error);
      return false;
    }
    if (!isInside(canonicalRoot, canonicalDirectory)) {
      fail(directory, "containment", new Error("directory resolves outside the sweep root"));
      return false;
    }

    let names: readonly string[];
    try {
      names = await fileSystem.readdir(directory);
    } catch (error) {
      fail(directory, "readdir", error);
      return false;
    }

    let removedAnything = false;
    for (const name of names) {
      if (examined >= options.maxEntries) {
        truncated = true;
        break;
      }
      examined += 1;
      if (examined % YIELD_EVERY_ENTRIES === 0) {
        await yieldToEventLoop();
      }

      const target = path.join(directory, name);
      let stat: SweepEntryStat;
      try {
        stat = await fileSystem.lstat(target);
      } catch (error) {
        fail(target, "lstat", error);
        continue;
      }

      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (await walk(target, false)) {
          removedAnything = true;
        }
        if (truncated) {
          break;
        }
        continue;
      }

      if (!isOld(stat)) {
        continue;
      }
      const isLink = stat.isSymbolicLink();
      if (!isLink && !stat.isFile()) {
        continue;
      }
      try {
        await fileSystem.unlink(target);
      } catch (error) {
        fail(target, "unlink", error);
        continue;
      }
      removedAnything = true;
      if (isLink) {
        deletedSymlinks += 1;
      } else {
        deletedFiles += 1;
        bytesFreed += stat.size;
      }
    }

    if (isRoot || !removedAnything) {
      return false;
    }
    try {
      if ((await fileSystem.readdir(directory)).length > 0) {
        return false;
      }
      await fileSystem.rmdir(directory);
      prunedDirectories += 1;
      return true;
    } catch (error) {
      fail(directory, "rmdir", error);
      return false;
    }
  };

  try {
    await walk(options.root, true);
  } catch (error) {
    fail(options.root, "readdir", error);
  }
  return finish();
}
