/**
 * Bounded, descriptor-relative age-based cleanup. Directories are opened without following
 * links; inspection, enumeration and unlinking stay attached to those handles even if an
 * ancestor is replaced. FileSweep shares one entry budget across discovery and recursive work.
 * The native implementation is imported only when a sweep actually runs; load failure stops it.
 */
import * as path from "node:path";
import type { SweepDirectory } from "./sweep-directory";

export const YIELD_EVERY_ENTRIES = 64;
export interface SweepFailure {
  readonly path: string;
  readonly operation: "lstat" | "readdir" | "unlink" | "rmdir" | "containment";
  readonly message: string;
}
export interface SweepResult {
  readonly examined: number;
  readonly deletedFiles: number;
  readonly deletedSymlinks: number;
  readonly prunedDirectories: number;
  readonly bytesFreed: number;
  readonly truncated: boolean;
  readonly failures: readonly SweepFailure[];
}
export interface SweepOptions {
  readonly root: string;
  readonly now: number;
  readonly maxAgeMs: number;
  readonly maxEntries: number;
  readonly openDirectory?: (root: string) => SweepDirectory;
  readonly yieldToEventLoop?: () => Promise<void>;
}
export function missingSweepPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Shared counters and budget for a complete sweep, including its directory discovery. */
export class FileSweep {
  private readonly counters = {
    examined: 0,
    deletedFiles: 0,
    deletedSymlinks: 0,
    prunedDirectories: 0,
    bytesFreed: 0,
    truncated: false,
    failures: [] as SweepFailure[],
  };
  constructor(private readonly options: Omit<SweepOptions, "root" | "openDirectory">) {}
  result(): SweepResult {
    return this.counters;
  }
  fail(target: string, operation: SweepFailure["operation"], error: unknown): void {
    if (!missingSweepPath(error)) {
      this.counters.failures.push({
        path: target,
        operation,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  async take(): Promise<boolean> {
    if (
      !Number.isFinite(this.options.maxEntries) ||
      this.counters.examined >= this.options.maxEntries
    ) {
      this.counters.truncated = true;
      return false;
    }
    this.counters.examined += 1;
    if (this.counters.examined % YIELD_EVERY_ENTRIES === 0) {
      await (this.options.yieldToEventLoop?.() ??
        new Promise<void>((resolve) => setImmediate(resolve)));
    }
    return true;
  }
  prune(parent: SweepDirectory, name: string, target: string): boolean {
    try {
      parent.remove(name, true);
      this.counters.prunedDirectories += 1;
      return true;
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ENOTEMPTY" || error.code === "EEXIST")
      )) {
        this.fail(target, "rmdir", error);
      }
      return false;
    }
  }
  /** Returns whether anything was removed; never removes its own root handle. */
  async walk(directory: SweepDirectory, target: string): Promise<boolean> {
    let removed = false;
    try {
      for (const name of directory.entries()) {
        if (!(await this.take())) {
          break;
        }
        const childPath = path.join(target, name);
        let stat: ReturnType<SweepDirectory["stat"]>;
        try {
          stat = directory.stat(name);
        } catch (error) {
          this.fail(childPath, "lstat", error);
          continue;
        }
        if (stat.isDirectory()) {
          let child: SweepDirectory;
          try {
            child = directory.child(name);
          } catch (error) {
            this.fail(childPath, "containment", error);
            continue;
          }
          let changed: boolean;
          try {
            changed = await this.walk(child, childPath);
          } finally {
            child.close();
          }
          if (changed) {
            removed = this.prune(directory, name, childPath) || removed;
          }
          if (this.counters.truncated) {
            break;
          }
          continue;
        }
        const link = stat.isSymbolicLink();
        if (
          (!link && !stat.isFile()) ||
          !(this.options.now - stat.mtimeMs > this.options.maxAgeMs)
        ) {
          continue;
        }
        try {
          directory.remove(name);
        } catch (error) {
          this.fail(childPath, "unlink", error);
          continue;
        }
        removed = true;
        if (link) {
          this.counters.deletedSymlinks += 1;
        } else {
          this.counters.deletedFiles += 1;
          this.counters.bytesFreed += stat.size;
        }
      }
    } catch (error) {
      this.fail(target, "readdir", error);
    }
    return removed;
  }
}

export async function sweepStaleFiles(options: SweepOptions): Promise<SweepResult> {
  const sweep = new FileSweep(options);
  let root: SweepDirectory | undefined;
  try {
    const open = options.openDirectory ?? (await import("./sweep-directory")).SweepDirectory.open;
    root = open(options.root);
    await sweep.walk(root, options.root);
  } catch (error) {
    sweep.fail(options.root, "containment", error);
  } finally {
    root?.close();
  }
  return sweep.result();
}
