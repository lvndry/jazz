import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import {
  FILE_LOCK_MAX_RETRIES,
  FILE_LOCK_RETRY_DELAY_MS,
  FILE_LOCK_TIMEOUT_MS,
} from "@/core/constants/agent";

/**
 * Directory-based mutex shared by any store that needs cross-process,
 * concurrent-safe read-modify-write (conversation history, memory, ...).
 *
 * `fs.makeDirectory` is atomic (fails if the directory already exists), so it
 * doubles as a lock primitive. A stale lock (owner crashed mid-write) is
 * reclaimed once its mtime exceeds FILE_LOCK_TIMEOUT_MS.
 */
function acquireLock(lockPath: string): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (let attempt = 0; attempt < FILE_LOCK_MAX_RETRIES; attempt++) {
      const acquired = yield* fs.makeDirectory(lockPath, { recursive: false }).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false)),
      );
      if (acquired) return;

      const statResult = yield* fs.stat(lockPath).pipe(Effect.option);
      const stat = Option.getOrNull(statResult);
      const mtimeMs = Option.match(stat?.mtime ?? Option.none(), {
        onNone: () => 0,
        onSome: (d) => d.getTime(),
      });
      if (stat && Date.now() - mtimeMs > FILE_LOCK_TIMEOUT_MS) {
        yield* fs.remove(lockPath, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
        continue;
      }
      yield* Effect.sleep(FILE_LOCK_RETRY_DELAY_MS);
    }
    return yield* Effect.fail(new Error(`Failed to acquire lock at ${lockPath} after retries`));
  });
}

function releaseLock(lockPath: string): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(lockPath, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));
  });
}

/**
 * Run `operation` while holding the directory-mutex at `lockPath`.
 *
 * Guardrail checks (size/count caps) that gate a write must run INSIDE
 * `operation`, alongside the write itself — never as a separate acquire/use/
 * release pair before this one, or a concurrent writer can slip in between
 * the two lock acquisitions and the guardrail becomes advisory only.
 */
export function withLock<A, E, R>(
  lockPath: string,
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R | FileSystem.FileSystem> {
  return Effect.acquireUseRelease(
    acquireLock(lockPath),
    () => operation,
    () => releaseLock(lockPath),
  );
}
