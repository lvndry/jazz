/**
 * Shared primitives for Jazz's filesystem-backed stores.
 *
 * This module owns storage directory selection, storage-safe agent IDs,
 * atomic text writes, and user-facing formatting of backing paths.
 */
import * as os from "node:os";
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import {
  FILE_LOCK_MAX_RETRIES,
  FILE_LOCK_RETRY_DELAY_MS,
  FILE_LOCK_TIMEOUT_MS,
} from "@/core/constants/agent";
import type { StorageConfig } from "../types";
import { getGlobalUserDataDirectory } from "./paths";

const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface AgentIdErrorConstructor<E extends Error> {
  new (message: string): E;
}

/**
 * Resolve the effective directory that should be used for file-based storage.
 * Falls back to the default data directory when storage is not file-based or
 * when the configured path is empty.
 */
export function resolveStorageDirectory(storage: StorageConfig): string {
  if (storage.type === "file") {
    const trimmed = storage.path?.trim();
    if (trimmed && trimmed.length > 0) {
      return trimmed;
    }
  }

  return getGlobalUserDataDirectory();
}

/**
 * Require a storage key (agent id, memory scope name, etc.) to satisfy Jazz's
 * storage-safe format: 1–64 ASCII letters, digits, underscores, and hyphens,
 * since these values become file and lock names. `label` names the kind of
 * key in the error message (e.g. "agent id", "memory scope"). The caller
 * supplies its domain error class so the returned Effect retains a useful
 * typed error channel.
 */
export function requireValidStorageKey<E extends Error>(
  key: string,
  label: string,
  ErrorConstructor: AgentIdErrorConstructor<E>,
): Effect.Effect<void, E> {
  return AGENT_ID_PATTERN.test(key)
    ? Effect.void
    : Effect.fail(new ErrorConstructor(`Invalid ${label}: "${key}".`));
}

/**
 * Require an agent identifier to satisfy Jazz's storage-safe format.
 *
 * Agent IDs become file and lock names, so only 1–64 ASCII letters, digits,
 * underscores, and hyphens are accepted. The caller supplies its domain error
 * class so the returned Effect retains a useful typed error channel.
 */
export function requireValidAgentId<E extends Error>(
  agentId: string,
  ErrorConstructor: AgentIdErrorConstructor<E>,
): Effect.Effect<void, E> {
  return requireValidStorageKey(agentId, "agent id", ErrorConstructor);
}

/**
 * Replace an exact home-directory prefix with `~` for user-facing output.
 *
 * Paths outside the home directory are returned unchanged. This function only
 * formats a path; it does not resolve or validate it.
 */
export function abbreviateHomePath(targetPath: string): string {
  const homeDirectory = os.homedir();
  if (homeDirectory.length === 0) return targetPath;
  if (targetPath === homeDirectory) return "~";
  if (targetPath.startsWith(homeDirectory + path.sep)) {
    return `~${targetPath.slice(homeDirectory.length)}`;
  }
  return targetPath;
}

export interface AtomicFileWriteOptions {
  /** Human-readable prefix used to identify leftover temporary files. */
  readonly tempPrefix: string;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Acquire a directory mutex, reclaiming locks whose mtime exceeds the timeout.
 *
 * Staleness is based only on elapsed time, so FILE_LOCK_TIMEOUT_MS must exceed
 * the longest protected operation.
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
      const modifiedAt = Option.match(stat?.mtime ?? Option.none(), {
        onNone: () => 0,
        onSome: (date) => date.getTime(),
      });
      if (stat && Date.now() - modifiedAt > FILE_LOCK_TIMEOUT_MS) {
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
 * Run an operation while holding a cross-process directory mutex.
 *
 * Read/validate/write sequences must all occur inside the supplied operation;
 * splitting guardrail checks across lock acquisitions introduces races.
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

/**
 * Atomically replace a text file by writing and renaming a sibling temporary file.
 *
 * The parent directory is created when needed. A failed rename triggers a
 * best-effort removal of the temporary file. Filesystem failures surface as
 * generic Error values; callers must not branch on message text.
 */
export function writeFileStringAtomic(
  fs: FileSystem.FileSystem,
  targetPath: string,
  content: string,
  options: AtomicFileWriteOptions,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const directory = path.dirname(targetPath);
    const tempPath = path.join(
      directory,
      `.${options.tempPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );

    yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(toError));
    yield* fs.writeFileString(tempPath, content).pipe(Effect.mapError(toError));
    yield* fs.rename(tempPath, targetPath).pipe(
      Effect.tapError(() => fs.remove(tempPath).pipe(Effect.catchAll(() => Effect.void))),
      Effect.mapError(toError),
    );
  });
}
