/**
 * Shared primitives for Jazz's filesystem-backed stores.
 *
 * This module owns storage directory selection, storage-safe agent IDs, the
 * Effect face of the shared file lock and durable writes, quarantine of
 * unreadable state files, and user-facing formatting of backing paths.
 */
import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { type DurableWriteOptions, writeFileDurably } from "@/core/utils/durable-file";
import { acquireFileLock, type FileLockOptions } from "@/core/utils/file-lock";
import type { StorageConfig } from "../types";
import { toError } from "./errors";
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
 * Whether a storage key satisfies Jazz's storage-safe format. Prefer
 * {@link requireValidStorageKey} where an invalid key should fail; this
 * predicate exists for callers that must skip an invalid key without
 * aborting the surrounding operation.
 */
export function isValidStorageKey(key: string): boolean {
  return AGENT_ID_PATTERN.test(key);
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

/**
 * Run an operation while holding a cross-process lock (see `file-lock.ts`).
 *
 * Read/validate/write sequences must all occur inside the supplied operation;
 * splitting guardrail checks across lock acquisitions introduces races. The
 * parent directory of `lockPath` is created first, so callers can lock a store
 * before its directory exists.
 */
export function withLock<A, E, R>(
  lockPath: string,
  operation: Effect.Effect<A, E, R>,
  options?: FileLockOptions,
): Effect.Effect<A, E | Error, R> {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => acquireFileLock(lockPath, options),
      catch: toError,
    }),
    () => operation,
    (release) => Effect.promise(() => release().catch(() => undefined)),
  );
}

/**
 * Atomically and durably replace a text file (see `writeFileDurably`): a crash
 * leaves the old content or the new, never a torn file. The file is private to
 * its owner (0600) unless `options.mode` says otherwise, and a missing parent
 * directory is created with mode 0700.
 */
export function writeFileStringAtomic(
  targetPath: string,
  content: string,
  options?: DurableWriteOptions,
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: () => writeFileDurably(targetPath, content, options),
    catch: toError,
  });
}

/**
 * Move an unreadable state file aside to `<file>.corrupt-<timestamp>` and warn,
 * so the caller can continue from an empty store without overwriting the bytes.
 * Returns the quarantine path. A file that vanished in the meantime is not an
 * error; any other rename failure is, because continuing would overwrite it.
 */
export function quarantineCorruptFile(
  filePath: string,
  reason: string,
): Effect.Effect<string, Error> {
  const quarantinePath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  return Effect.tryPromise({
    try: async () => {
      try {
        await nodeFs.rename(filePath, quarantinePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return quarantinePath;
        }
        throw error;
      }
      console.error(
        `[jazz] ${filePath} could not be read (${reason}). It was moved to ${quarantinePath} and a fresh file will be started.`,
      );
      return quarantinePath;
    },
    catch: toError,
  });
}
