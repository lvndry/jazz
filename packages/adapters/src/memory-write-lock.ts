/**
 * The one lock every memory write takes. It covers all scopes because the
 * source ledger is a single file shared by them, and receipts snapshot entry
 * IDs that writes assign.
 */
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { toError, withLock } from "@jazz/core/utils/storage";
import { Effect } from "effect";

export const MEMORY_WRITE_LOCK_FILENAME = ".write.lock";

export function memoryWriteLockPath(memoryDirectory: string): string {
  return path.join(memoryDirectory, MEMORY_WRITE_LOCK_FILENAME);
}

export function withMemoryWriteLock<A, E, R>(
  memoryDirectory: string,
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R | FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(memoryDirectory, { recursive: true }).pipe(Effect.mapError(toError));
    return yield* withLock(memoryWriteLockPath(memoryDirectory), operation);
  });
}
