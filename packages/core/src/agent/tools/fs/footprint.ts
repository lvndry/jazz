import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { formatByteSize } from "@/core/utils/string";

/**
 * Entries visited before a footprint stops counting. An approval has to open
 * promptly, and past this many files the exact total changes nobody's decision:
 * "10,000+ files" says what matters.
 */
export const FOOTPRINT_ENTRY_LIMIT = 10_000;

export interface Footprint {
  readonly files: number;
  readonly bytes: number;
  /** True when the walk stopped at {@link FOOTPRINT_ENTRY_LIMIT}; the counts are a floor. */
  readonly truncated: boolean;
}

/**
 * How many files and bytes a path holds: one file, or everything under a
 * directory. Unreadable entries are skipped, and a path that cannot be read
 * at all yields undefined.
 */
export function measureFootprint(
  target: string,
  entryLimit: number = FOOTPRINT_ENTRY_LIMIT,
): Effect.Effect<Footprint | undefined, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.stat(target).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    if (root === undefined) {
      return undefined;
    }
    if (root.type !== "Directory") {
      return { files: 1, bytes: Number(root.size), truncated: false };
    }

    let files = 0;
    let bytes = 0;
    let visited = 0;
    const pending = [target];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) {
        break;
      }
      const names = yield* fs
        .readDirectory(directory)
        .pipe(Effect.catchAll(() => Effect.succeed([] as string[])));
      for (const name of names) {
        if (visited >= entryLimit) {
          return { files, bytes, truncated: true };
        }
        visited += 1;
        const entryPath = `${directory}/${name}`;
        const info = yield* fs
          .stat(entryPath)
          .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
        if (info === undefined) {
          continue;
        }
        if (info.type === "Directory") {
          pending.push(entryPath);
        } else {
          files += 1;
          bytes += Number(info.size);
        }
      }
    }
    return { files, bytes, truncated: false };
  });
}

/** `1 file, 12 KB`, `214 files, 1.3 GB`, or `10,000+ files, 4.2 GB` when the walk stopped early. */
export function describeFootprint(footprint: Footprint): string {
  const count = footprint.files.toLocaleString("en-US");
  const files = `${count}${footprint.truncated ? "+" : ""} ${footprint.files === 1 && !footprint.truncated ? "file" : "files"}`;
  return `${files}, ${formatByteSize(footprint.bytes)}`;
}
