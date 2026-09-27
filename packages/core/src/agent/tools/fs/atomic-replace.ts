/**
 * Replacing files and directories so that a reader, or an interrupted tool call, sees either
 * the old version or the new one and never a partial one.
 *
 * A tool call can be interrupted at any moment (Esc, `--timeout`, SIGTERM, a run deadline).
 * Writing a file in place truncates it first, so an interrupt mid-write left a truncated file;
 * removing a destination before copying over it left nothing at all. Here the new version is
 * staged beside the target and swapped in with `rename`, and the swap runs uninterruptibly, so
 * an interrupt lands before it (nothing changed) or after it (the change is complete).
 *
 * - {@link writeFileAtomically}: `write_file` and `edit_file`.
 * - {@link replacePathAtomically}: `cp` and `mv`, files and directories.
 */

import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { toError } from "@/core/utils/errors";
import { writeFileStringAtomic } from "@/core/utils/storage";

/** Permission bits of a file mode: what a replacement must keep. */
const PERMISSION_BITS = 0o7777;

/** A sibling path of `target` for staging, unique per call. */
function siblingPath(target: string, label: string): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(path.dirname(target), `.jazz-${label}-${path.basename(target)}-${unique}`);
}

/**
 * Replace a text file's content in one step, keeping its permissions. A symlink is followed, so
 * the file it points to is replaced and the link stays a link. A missing file is created.
 */
export function writeFileAtomically(
  fs: FileSystem.FileSystem,
  target: string,
  content: string,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const exists = yield* fs.exists(target).pipe(Effect.catchAll(() => Effect.succeed(false)));
    const realTarget = exists
      ? yield* fs.realPath(target).pipe(Effect.catchAll(() => Effect.succeed(target)))
      : target;
    const mode = exists
      ? yield* fs.stat(realTarget).pipe(
          Effect.map((info) => info.mode & PERMISSION_BITS),
          Effect.catchAll(() => Effect.succeed(undefined)),
        )
      : undefined;

    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* writeFileStringAtomic(fs, realTarget, content, {
          tempPrefix: "jazz-write",
          ...(mode !== undefined ? { mode } : {}),
        });
        // The temp file's mode went through the umask; set the original bits exactly.
        if (mode !== undefined) {
          yield* fs.chmod(realTarget, mode).pipe(Effect.mapError(toError));
        }
      }),
    );
  });
}

/**
 * Put a staged version in place of `destination`, whether or not something is there already.
 *
 * `stage` builds the new version at the staging path it is given, a sibling of `destination`
 * (so the final rename never crosses a filesystem). It may be interrupted or fail; the partial
 * staging copy is then removed and nothing else has changed. The swap that follows is
 * uninterruptible: an existing destination is moved aside, the staged version renamed into
 * place, and the old one deleted, restoring it if the rename fails. `afterCommit` runs inside
 * the same uninterruptible section, for work that must happen together with the swap, such as
 * `mv` removing its source.
 */
export function replacePathAtomically(
  fs: FileSystem.FileSystem,
  destination: string,
  stage: (stagingPath: string) => Effect.Effect<void, Error>,
  afterCommit: Effect.Effect<void, Error> = Effect.void,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const stagingPath = siblingPath(destination, "stage");
    const removeStaging = fs
      .remove(stagingPath, { recursive: true })
      .pipe(Effect.catchAll(() => Effect.void));

    yield* stage(stagingPath).pipe(Effect.onError(() => removeStaging));

    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const destinationExists = yield* fs
          .exists(destination)
          .pipe(Effect.catchAll(() => Effect.succeed(false)));
        if (!destinationExists) {
          yield* fs.rename(stagingPath, destination).pipe(
            Effect.mapError(toError),
            Effect.tapError(() => removeStaging),
          );
          yield* afterCommit;
          return;
        }

        const backupPath = siblingPath(destination, "previous");
        yield* fs.rename(destination, backupPath).pipe(
          Effect.mapError(toError),
          Effect.tapError(() => removeStaging),
        );
        yield* fs.rename(stagingPath, destination).pipe(
          Effect.mapError(toError),
          Effect.tapError(() =>
            fs.rename(backupPath, destination).pipe(
              Effect.catchAll(() => Effect.void),
              Effect.zipRight(removeStaging),
            ),
          ),
        );
        yield* fs.remove(backupPath, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
        yield* afterCommit;
      }),
    );
  });
}
