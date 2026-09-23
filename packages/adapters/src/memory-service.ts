/**
 * Implements `MemoryService`: persistent notes-to-self, stored as files under
 * a per-scope memory directory with path and quota guardrails enforced here.
 * A scope (e.g. "personal", "finance", "github-project-a") is the unit of
 * storage — independent of agent identity, so several agents can share one.
 */

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import {
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_FILES_PER_SCOPE,
  MAX_MEMORY_PATH_DEPTH,
  MAX_MEMORY_PATH_SEGMENT_LENGTH,
  MAX_MEMORY_TOTAL_BYTES_PER_SCOPE,
  MEMORY_SUMMARY_MAX_CHARS,
  MEMORY_VIEW_MAX_LINES,
  MEMORY_VIEW_TRUNCATE_CHARS,
} from "@jazz/core/constants/memory";
import type {
  MemoryEntryCredit,
  MemoryFileProvenance,
  MemoryScopeProvenance,
  MemoryFailureSignature,
} from "@jazz/core/interfaces/memory-provenance";
import {
  EMPTY_MEMORY_SCOPE_PROVENANCE,
  MEMORY_PROVENANCE_FILENAME,
} from "@jazz/core/interfaces/memory-provenance";
import type {
  MemoryDirectoryEntry,
  MemoryEntryInForce,
  MemoryMutationOutcome,
  MemoryService,
  MemoryViewOutcome,
  MemoryWriteContext,
} from "@jazz/core/interfaces/memory-service";
import { MemoryServiceTag } from "@jazz/core/interfaces/memory-service";
import { ALWAYS_SEGMENT, WHEN_SEGMENT } from "@jazz/core/memory/entry-path";
import { getMemoryDirectory } from "@jazz/core/utils/paths";
import {
  abbreviateHomePath,
  isValidStorageKey,
  requireValidStorageKey,
  withLock,
  writeFileStringAtomic,
} from "@jazz/core/utils/storage";
import { findAllOccurrenceLineNumbers } from "@jazz/core/utils/string";
import { resolveVirtualPath, type VirtualPathViolation } from "@jazz/core/utils/virtual-path";
import { Effect, Layer } from "effect";
import {
  prepareMemorySourceDelete,
  prepareMemorySourceRename,
  prepareMemorySourceWrite,
} from "./memory-source-ledger";

/** Raised for memory quota and scope-validity guardrail violations. */
export class MemoryGuardrailViolation extends Error {}

const MEMORY_PATH_OPTIONS = {
  maxDepth: MAX_MEMORY_PATH_DEPTH,
  maxSegmentLength: MAX_MEMORY_PATH_SEGMENT_LENGTH,
} as const;

function resolveMemoryPath(
  memoryRoot: string,
  virtualPath: string,
): Effect.Effect<string, VirtualPathViolation | Error> {
  if (virtualPath.split(/[\\/]/).some((segment) => segment.startsWith("."))) {
    return Effect.fail(
      new MemoryGuardrailViolation("Hidden memory bookkeeping paths cannot be addressed."),
    );
  }
  return resolveVirtualPath(memoryRoot, virtualPath, MEMORY_PATH_OPTIONS);
}

/**
 * Splits a memory-tool path into its leading scope segment and the remainder
 * within that scope (e.g. `"personal/notes.md"` -> `{ scope: "personal", rest:
 * "notes.md" }`). An empty or root path has no scope segment at all.
 */
function splitScopeAndRest(virtualPath: string): { scope: string | null; rest: string } {
  const trimmed = virtualPath.replace(/^\/+/, "");
  if (trimmed === "") return { scope: null, rest: "" };
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex === -1) return { scope: trimmed, rest: "" };
  return { scope: trimmed.slice(0, slashIndex), rest: trimmed.slice(slashIndex + 1) };
}

interface MemoryTreeStats {
  readonly totalBytes: number;
  readonly fileCount: number;
}

function walkMemoryTree(
  fs: FileSystem.FileSystem,
  dir: string,
): Effect.Effect<MemoryTreeStats, Error> {
  return Effect.gen(function* () {
    const names = yield* fs
      .readDirectory(dir)
      .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));

    let totalBytes = 0;
    let fileCount = 0;
    for (const name of names) {
      // Hidden entries are Jazz's own bookkeeping (the provenance sidecar), not
      // saved memory, so they must not consume the operator's byte or file
      // budget — and they are excluded from listings for the same reason.
      if (name.startsWith(".")) continue;
      const entryPath = path.join(dir, name);
      const info = yield* fs.stat(entryPath).pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (!info) continue;
      if (info.type === "Directory") {
        const nested = yield* walkMemoryTree(fs, entryPath);
        totalBytes += nested.totalBytes;
        fileCount += nested.fileCount;
      } else if (info.type === "File") {
        totalBytes += Number(info.size);
        fileCount += 1;
      }
    }
    return { totalBytes, fileCount };
  });
}

function listDirectoryEntries(
  fs: FileSystem.FileSystem,
  dir: string,
  depthRemaining: number,
): Effect.Effect<MemoryDirectoryEntry[], Error> {
  return Effect.gen(function* () {
    const names = yield* fs
      .readDirectory(dir)
      .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));
    const visible = names.filter((name) => !name.startsWith(".")).sort();

    const entries: MemoryDirectoryEntry[] = [];
    for (const name of visible) {
      const entryPath = path.join(dir, name);
      const info = yield* fs.stat(entryPath).pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (!info) continue;

      if (info.type === "Directory") {
        entries.push({ name: `${name}/`, kind: "directory", sizeBytes: 0 });
        if (depthRemaining > 1) {
          const nested = yield* listDirectoryEntries(fs, entryPath, depthRemaining - 1);
          for (const child of nested) {
            entries.push({ ...child, name: `${name}/${child.name}` });
          }
        }
      } else if (info.type === "File") {
        entries.push({ name, kind: "file", sizeBytes: Number(info.size) });
      }
    }
    return entries;
  });
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Coerces one record to the shape the rest of the code dereferences.
 *
 * These files are meant to be hand-edited, so a field can be any shape by the
 * time it is read back. Coercing rather than trusting keeps a malformed value
 * from either throwing deep inside a write (`writtenBy.includes` on a
 * non-array) or reaching the model as an `[object Object]` bullet in the system
 * prompt, and it degrades one field instead of discarding the whole record.
 */
function sanitizeFileProvenance(value: unknown, now: string): MemoryFileProvenance {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;

  return {
    createdAt: asOptionalString(record["createdAt"]) ?? now,
    updatedAt: asOptionalString(record["updatedAt"]) ?? now,
    ...(asOptionalString(record["lastViewedAt"]) !== undefined
      ? { lastViewedAt: record["lastViewedAt"] as string }
      : {}),
    writeCount: typeof record["writeCount"] === "number" ? record["writeCount"] : 0,
    writtenBy: asStringArray(record["writtenBy"]),
    ...(asOptionalString(record["subject"]) !== undefined
      ? { subject: record["subject"] as string }
      : {}),
    ...(asOptionalString(record["summary"]) !== undefined
      ? { summary: record["summary"] as string }
      : {}),
    ...(asOptionalString(record["origin"]) === "auto" ||
    asOptionalString(record["origin"]) === "user"
      ? { origin: record["origin"] as "auto" | "user" }
      : {}),
    ...(isMemoryFailureSignature(record["failure"]) ? { failure: record["failure"] } : {}),
    ...(isMemoryEntryCredit(record["credit"]) ? { credit: record["credit"] } : {}),
    ...(asOptionalString(record["compiledInto"]) !== undefined
      ? { compiledInto: record["compiledInto"] as string }
      : {}),
    ...(typeof record["stale"] === "boolean" ? { stale: record["stale"] } : {}),
  };
}

function isMemoryFailureSignature(value: unknown): value is MemoryFailureSignature {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate["kind"] === "misfire") {
    return typeof candidate["toolName"] === "string" && typeof candidate["errorClass"] === "string";
  }
  return candidate["kind"] === "correction" && typeof candidate["correctedBehavior"] === "string";
}

function isMemoryEntryCredit(value: unknown): value is MemoryEntryCredit {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["helped"] === "number" &&
    typeof candidate["failed"] === "number" &&
    typeof candidate["missed"] === "number" &&
    typeof candidate["everFired"] === "boolean"
  );
}

/**
 * Whether the sidecar could be read, as opposed to what it contained.
 *
 * A file that is simply absent is an ordinary empty scope. A file that exists
 * but cannot be read or parsed — permission denied, a directory in its place,
 * malformed JSON — is a fault, and the difference matters on the write path:
 * every writer rewrites the whole map, so treating an unreadable file as "no
 * records" would replace a scope's entire history with one entry.
 */
type ProvenanceReadStatus = "ok" | "absent" | "unreadable";

interface ProvenanceRead {
  readonly status: ProvenanceReadStatus;
  readonly provenance: MemoryScopeProvenance;
}

/**
 * Reads a scope's provenance sidecar, reporting whether it could be read.
 *
 * `JSON.parse` runs inside `Effect.try` rather than `Effect.map` because a
 * throw inside `map` becomes a defect, which `catchAll` does not catch — a
 * single malformed byte in a hand-editable file would otherwise take down every
 * run that reads it.
 */
function readScopeProvenance(
  fs: FileSystem.FileSystem,
  scopeRoot: string,
): Effect.Effect<ProvenanceRead, never> {
  const sidecarPath = path.join(scopeRoot, MEMORY_PROVENANCE_FILENAME);

  return fs.readFileString(sidecarPath).pipe(
    Effect.flatMap((raw) =>
      Effect.try(() => {
        const parsed: unknown = JSON.parse(raw);
        const files =
          typeof parsed === "object" && parsed !== null
            ? (parsed as { files?: unknown }).files
            : undefined;
        if (typeof files !== "object" || files === null) throw new Error("malformed sidecar");

        const now = new Date().toISOString();
        const sanitized: Record<string, MemoryFileProvenance> = {};
        for (const [key, value] of Object.entries(files as Record<string, unknown>)) {
          sanitized[key] = sanitizeFileProvenance(value, now);
        }
        return { status: "ok" as const, provenance: { files: sanitized } };
      }),
    ),
    Effect.catchAll((error) => {
      const platformError = error as { _tag?: string; reason?: string };
      const absent = platformError._tag === "SystemError" && platformError.reason === "NotFound";
      return Effect.succeed({
        status: absent ? "absent" : "unreadable",
        provenance: EMPTY_MEMORY_SCOPE_PROVENANCE,
      } satisfies ProvenanceRead);
    }),
  );
}

/**
 * Moves an unreadable sidecar aside so a write can proceed without erasing it.
 *
 * Writers rebuild the whole map, so continuing from an unreadable file would
 * silently replace every record in the scope. Keeping the bytes under a
 * `.corrupt-<timestamp>` name means the history is recoverable by hand instead
 * of gone.
 */
function quarantineProvenance(
  fs: FileSystem.FileSystem,
  scopeRoot: string,
): Effect.Effect<void, never> {
  const sidecarPath = path.join(scopeRoot, MEMORY_PROVENANCE_FILENAME);
  const quarantinedPath = `${sidecarPath}.corrupt-${Date.now()}`;
  return fs.rename(sidecarPath, quarantinedPath).pipe(Effect.catchAll(() => Effect.void));
}

/**
 * Reads the sidecar for a writer, quarantining it first when it is unreadable.
 *
 * Returns the records a write should build on: the existing ones, or an empty
 * map once the unreadable file has been moved aside.
 */
function readProvenanceForWrite(
  fs: FileSystem.FileSystem,
  scopeRoot: string,
): Effect.Effect<MemoryScopeProvenance, never> {
  return readScopeProvenance(fs, scopeRoot).pipe(
    Effect.flatMap((read) =>
      read.status === "unreadable"
        ? quarantineProvenance(fs, scopeRoot).pipe(Effect.as(EMPTY_MEMORY_SCOPE_PROVENANCE))
        : Effect.succeed(read.provenance),
    ),
  );
}

function writeScopeProvenance(
  fs: FileSystem.FileSystem,
  scopeRoot: string,
  provenance: MemoryScopeProvenance,
): Effect.Effect<void, never> {
  return writeFileStringAtomic(
    fs,
    path.join(scopeRoot, MEMORY_PROVENANCE_FILENAME),
    `${JSON.stringify(provenance, null, 2)}\n`,
    { tempPrefix: "memory-provenance" },
  ).pipe(Effect.catchAll(() => Effect.void));
}

/**
 * Reads back the entry that was just written and takes its first non-empty
 * line as the summary. Deriving it from the file rather than accepting it from
 * the caller is what keeps the index text honest across every mutation —
 * `str_replace` and `insert` change the content too, not just `create`.
 */
function readEntrySummary(
  fs: FileSystem.FileSystem,
  absolutePath: string,
): Effect.Effect<string | undefined, never> {
  return fs.readFileString(absolutePath).pipe(
    Effect.map((content) => {
      const firstLine = content
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (firstLine === undefined) return undefined;
      return firstLine.replace(/^#+\s*/, "").slice(0, MEMORY_SUMMARY_MAX_CHARS);
    }),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );
}

/**
 * Records a write against `relativePath`, creating its entry if it is new.
 *
 * Existing fields are carried forward rather than rebuilt: the record holds
 * typing and credit counters that no single write knows about, and dropping
 * them here would silently reset an entry's learning history on its next edit.
 */
function recordWrite(
  fs: FileSystem.FileSystem,
  scopeRoot: string,
  relativePath: string,
  writeContext: MemoryWriteContext,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const provenance = yield* readProvenanceForWrite(fs, scopeRoot);
    const existing = provenance.files[relativePath];
    const now = new Date().toISOString();
    const writtenBy = existing?.writtenBy.includes(writeContext.agentId)
      ? existing.writtenBy
      : [...(existing?.writtenBy ?? []), writeContext.agentId];

    const entry = writeContext.entry;
    const summary = yield* readEntrySummary(fs, path.join(scopeRoot, relativePath));

    const updated: MemoryFileProvenance = {
      ...(existing ?? {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      writeCount: (existing?.writeCount ?? 0) + 1,
      writtenBy,
      ...(summary !== undefined ? { summary } : {}),
      ...(entry !== undefined
        ? {
            ...(entry.failure !== undefined ? { failure: entry.failure } : {}),
            ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
          }
        : {}),
    };

    yield* writeScopeProvenance(fs, scopeRoot, {
      files: { ...provenance.files, [relativePath]: updated },
    });
  });
}

/** Every record at `prefix` or beneath it, since a delete or rename may target a directory. */
function keysUnder(
  files: Readonly<Record<string, MemoryFileProvenance>>,
  prefix: string,
): readonly string[] {
  return Object.keys(files).filter((key) => key === prefix || key.startsWith(`${prefix}/`));
}

/**
 * Drops the records for a deleted path.
 *
 * `delete` removes directories recursively, so a record is matched by prefix
 * rather than exact key: keeping a child's record after its directory is gone
 * would leave an entry that recall keeps injecting and that nothing can view or
 * amend, because the file behind it no longer exists.
 */
function forgetProvenance(
  fs: FileSystem.FileSystem,
  scopeRoot: string,
  relativePath: string,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const provenance = yield* readProvenanceForWrite(fs, scopeRoot);
    const removed = keysUnder(provenance.files, relativePath);
    if (removed.length === 0) return;
    const files = { ...provenance.files };
    for (const key of removed) delete files[key];
    yield* writeScopeProvenance(fs, scopeRoot, { files });
  });
}

/**
 * Re-keys the records under a renamed path, carrying their history forward.
 *
 * A rename is how an entry changes when it applies — moving from
 * `when/<topic>/` to `always/`, for instance. Nothing needs re-deriving,
 * because the path is the map key: move the record and the new key already
 * says where the entry now applies. Children are moved with it, since renaming
 * a directory would otherwise leave every record beneath it pointing at a path
 * that no longer exists.
 */
function moveProvenance(
  fs: FileSystem.FileSystem,
  scopeRoot: string,
  fromPath: string,
  toPath: string,
  writeContext: MemoryWriteContext,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const provenance = yield* readProvenanceForWrite(fs, scopeRoot);
    const moved = keysUnder(provenance.files, fromPath);
    const files = { ...provenance.files };
    const now = new Date().toISOString();

    for (const key of moved) delete files[key];

    for (const key of moved) {
      const existing = provenance.files[key];
      const destination = key === fromPath ? toPath : `${toPath}${key.slice(fromPath.length)}`;
      files[destination] = {
        ...(existing ?? {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        writeCount: (existing?.writeCount ?? 0) + 1,
        writtenBy: existing?.writtenBy.includes(writeContext.agentId)
          ? existing.writtenBy
          : [...(existing?.writtenBy ?? []), writeContext.agentId],
      };
    }

    if (moved.length === 0) return;
    yield* writeScopeProvenance(fs, scopeRoot, { files });
  });
}

function touchViewed(
  fs: FileSystem.FileSystem,
  scopeRoot: string,
  relativePath: string,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const provenance = yield* readProvenanceForWrite(fs, scopeRoot);
    const existing = provenance.files[relativePath];
    if (existing === undefined) return;
    yield* writeScopeProvenance(fs, scopeRoot, {
      files: {
        ...provenance.files,
        [relativePath]: { ...existing, lastViewedAt: new Date().toISOString() },
      },
    });
  });
}

export interface MemoryServiceImplOptions {
  /** Override for tests; defaults to ~/.jazz/memory (or $JAZZ_HOME/memory). */
  readonly baseMemoryDirectory?: string;
  /** Override for tests; defaults to {@link MAX_MEMORY_FILE_BYTES}. */
  readonly maxFileBytes?: number;
  /** Override for tests; defaults to {@link MAX_MEMORY_TOTAL_BYTES_PER_SCOPE}. */
  readonly maxTotalBytesPerScope?: number;
  /** Override for tests; defaults to {@link MAX_MEMORY_FILES_PER_SCOPE}. */
  readonly maxFilesPerScope?: number;
}

/** A path names a scope outside the caller's accessible set, or names no scope at all. */
type ScopeResolution =
  | { readonly ok: true; readonly scope: string; readonly rest: string }
  | { readonly ok: false; readonly failure: MemoryMutationOutcome };

export class MemoryServiceImpl implements MemoryService {
  private readonly baseMemoryDirectory: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytesPerScope: number;
  private readonly maxFilesPerScope: number;

  constructor(options?: MemoryServiceImplOptions) {
    this.baseMemoryDirectory = options?.baseMemoryDirectory ?? getMemoryDirectory();
    this.maxFileBytes = options?.maxFileBytes ?? MAX_MEMORY_FILE_BYTES;
    this.maxTotalBytesPerScope = options?.maxTotalBytesPerScope ?? MAX_MEMORY_TOTAL_BYTES_PER_SCOPE;
    this.maxFilesPerScope = options?.maxFilesPerScope ?? MAX_MEMORY_FILES_PER_SCOPE;
  }

  /** One lock covers every scope so updates to the cross-scope source ledger cannot race. */
  private memoryLockPath(): string {
    return path.join(this.baseMemoryDirectory, ".write.lock");
  }

  private ensureScopeRoot(
    scope: string,
  ): Effect.Effect<string, MemoryGuardrailViolation | Error, FileSystem.FileSystem> {
    const baseMemoryDirectory = this.baseMemoryDirectory;
    return Effect.gen(function* () {
      yield* requireValidStorageKey(scope, "memory scope", MemoryGuardrailViolation);
      const fs = yield* FileSystem.FileSystem;
      const rawRoot = path.join(baseMemoryDirectory, scope);
      yield* fs
        .makeDirectory(rawRoot, { recursive: true })
        .pipe(Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))));
      return yield* Effect.tryPromise({
        try: () => nodeFs.realpath(rawRoot),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      });
    });
  }

  /**
   * Resolves a memory-tool path against the caller's accessible scopes,
   * returning the plain failure value `manage_memory` should surface (no
   * scope named, or a scope outside `scopes`) rather than throwing — a wrong
   * scope name is an expected model mistake, not a guardrail violation.
   */
  private resolveScope(scopes: readonly string[], virtualPath: string): ScopeResolution {
    const { scope, rest } = splitScopeAndRest(virtualPath);
    const scopeList = scopes.length > 0 ? scopes.join(", ") : "(no scopes configured)";

    if (scope === null) {
      return {
        ok: false,
        failure: {
          success: false,
          message: `Provide a memory scope in the path, e.g. "${scopes[0] ?? "personal"}/notes.md". Accessible scopes: ${scopeList}.`,
        },
      };
    }
    if (!scopes.includes(scope)) {
      return {
        ok: false,
        failure: {
          success: false,
          message: `Unknown memory scope "${scope}". Accessible scopes: ${scopeList}.`,
        },
      };
    }
    return { ok: true, scope, rest };
  }

  /**
   * Enforces the scope-wide byte and file-count caps for one write.
   * `addedBytes` is the write's net delta, so an edit is charged only its
   * growth rather than the whole file, and a shrinking edit always fits.
   *
   * Must be called inside the scope lock: it walks the whole tree, and the
   * result is only sound if no other write lands between the walk and the
   * write it authorizes.
   */
  private requireScopeBudget(
    fs: FileSystem.FileSystem,
    root: string,
    options: { readonly addedBytes: number; readonly addsFile: boolean; readonly subject: string },
  ): Effect.Effect<void, MemoryGuardrailViolation | Error> {
    const maxFilesPerScope = this.maxFilesPerScope;
    const maxTotalBytesPerScope = this.maxTotalBytesPerScope;
    return Effect.gen(function* () {
      if (options.addedBytes <= 0 && !options.addsFile) return;

      const stats = yield* walkMemoryTree(fs, root);
      if (options.addsFile && stats.fileCount + 1 > maxFilesPerScope) {
        return yield* Effect.fail(
          new MemoryGuardrailViolation(
            `${options.subject} would exceed the maximum of ${maxFilesPerScope} files in memory.`,
          ),
        );
      }
      if (stats.totalBytes + options.addedBytes > maxTotalBytesPerScope) {
        return yield* Effect.fail(
          new MemoryGuardrailViolation(
            `${options.subject} would exceed the total memory budget of ${maxTotalBytesPerScope} bytes.`,
          ),
        );
      }
    });
  }

  /** Validate a caller's scope before entering the global memory write lock. */
  private withValidatedMemoryLock<A, E, R>(
    scope: string,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | MemoryGuardrailViolation | Error, R | FileSystem.FileSystem> {
    const lockPath = this.memoryLockPath();
    return Effect.gen(
      function* (this: MemoryServiceImpl) {
        yield* requireValidStorageKey(scope, "memory scope", MemoryGuardrailViolation);
        const fs = yield* FileSystem.FileSystem;
        yield* fs
          .makeDirectory(this.baseMemoryDirectory, { recursive: true })
          .pipe(
            Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))),
          );
        return yield* withLock(lockPath, operation);
      }.bind(this),
    );
  }

  readonly view: MemoryService["view"] = (scopes, virtualPath, viewRange) =>
    Effect.gen(
      function* (this: MemoryServiceImpl) {
        const fs = yield* FileSystem.FileSystem;
        const { scope, rest } = splitScopeAndRest(virtualPath);

        if (scope === null) {
          const entries: MemoryDirectoryEntry[] = [];
          for (const name of [...scopes].sort()) {
            entries.push({ name: `${name}/`, kind: "directory", sizeBytes: 0 });

            // A root listing must not create anything, so an unwritten scope
            // contributes only its own directory line. Walking an invalid
            // scope name is skipped rather than failed: it would be rejected
            // by any real access, and one bad config entry should not blank
            // out the listing for every other scope.
            const isValidScope = isValidStorageKey(name);
            if (!isValidScope) continue;

            const scopeRoot = path.join(this.baseMemoryDirectory, name);
            const nested = yield* listDirectoryEntries(fs, scopeRoot, 2);
            for (const child of nested) {
              entries.push({ ...child, name: `${name}/${child.name}` });
            }
          }
          return {
            kind: "directory",
            path: abbreviateHomePath(this.baseMemoryDirectory),
            entries,
          } satisfies MemoryViewOutcome;
        }

        if (!scopes.includes(scope)) {
          return {
            kind: "not_found",
            message: `Unknown memory scope "${scope}". Accessible scopes: ${scopes.length > 0 ? scopes.join(", ") : "(none configured)"}.`,
          } satisfies MemoryViewOutcome;
        }

        const root = yield* this.ensureScopeRoot(scope);
        const target = yield* resolveMemoryPath(root, rest);

        const info = yield* fs.stat(target).pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (!info) {
          return {
            kind: "not_found",
            message: `The path ${abbreviateHomePath(target)} does not exist. Please provide a valid path.`,
          } satisfies MemoryViewOutcome;
        }

        if (info.type === "Directory") {
          const entries = yield* listDirectoryEntries(fs, target, 2);
          return {
            kind: "directory",
            path: abbreviateHomePath(target),
            entries,
          } satisfies MemoryViewOutcome;
        }

        const content = yield* fs
          .readFileString(target)
          .pipe(Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))));
        const lines = content.split("\n");
        const totalLines = lines.length;

        if (totalLines > MEMORY_VIEW_MAX_LINES) {
          return {
            kind: "too_large",
            message: `File ${abbreviateHomePath(target)} exceeds maximum line limit of ${MEMORY_VIEW_MAX_LINES.toLocaleString()} lines.`,
          } satisfies MemoryViewOutcome;
        }

        const requestedStart = viewRange ? viewRange[0] : 1;
        const requestedEnd = viewRange
          ? viewRange[1] === -1
            ? totalLines
            : viewRange[1]
          : totalLines;
        const startLine = Math.max(1, Math.min(requestedStart, totalLines));
        const endLine = Math.max(startLine, Math.min(requestedEnd, totalLines));

        const selected = lines.slice(startLine - 1, endLine).join("\n");
        const truncated = selected.length > MEMORY_VIEW_TRUNCATE_CHARS;
        const displayContent = truncated ? selected.slice(0, MEMORY_VIEW_TRUNCATE_CHARS) : selected;

        yield* touchViewed(fs, root, path.relative(root, target));

        return {
          kind: "file",
          path: abbreviateHomePath(target),
          content: displayContent,
          startLine,
          totalLines,
          truncated,
        } satisfies MemoryViewOutcome;
      }.bind(this),
    );

  readonly conditionalEntries: MemoryService["conditionalEntries"] = (scopes, isRelevantTopic) =>
    Effect.gen(
      function* (this: MemoryServiceImpl) {
        const fs = yield* FileSystem.FileSystem;
        const entries: MemoryEntryInForce[] = [];
        for (const scope of scopes) {
          if (!isValidStorageKey(scope)) continue;
          const topicRoot = path.join(this.baseMemoryDirectory, scope, WHEN_SEGMENT);
          const topics = yield* fs
            .readDirectory(topicRoot)
            .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));
          for (const topic of topics.sort()) {
            if (topic.startsWith(".")) continue;
            if (isRelevantTopic !== undefined && !isRelevantTopic(topic)) continue;
            const topicPath = path.join(topicRoot, topic);
            const topicInfo = yield* fs
              .stat(topicPath)
              .pipe(Effect.catchAll(() => Effect.succeed(null)));
            if (topicInfo?.type !== "Directory") continue;
            const names = yield* fs
              .readDirectory(topicPath)
              .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));
            for (const name of names.sort()) {
              if (name.startsWith(".")) continue;
              const info = yield* fs
                .stat(path.join(topicPath, name))
                .pipe(Effect.catchAll(() => Effect.succeed(null)));
              if (info?.type !== "File") continue;
              const summary = yield* readEntrySummary(fs, path.join(topicPath, name));
              if (summary === undefined) continue;
              entries.push({
                path: `${scope}/${WHEN_SEGMENT}/${topic}/${name}`,
                scope,
                topic,
                summary,
              });
            }
          }
        }
        return entries;
      }.bind(this),
    );

  readonly standingEntries: MemoryService["standingEntries"] = (scopes) =>
    Effect.gen(
      function* (this: MemoryServiceImpl) {
        const fs = yield* FileSystem.FileSystem;
        const entries: MemoryEntryInForce[] = [];
        for (const scope of scopes) {
          if (!isValidStorageKey(scope)) continue;
          const absolute = path.join(this.baseMemoryDirectory, scope, ALWAYS_SEGMENT);
          const names = yield* fs
            .readDirectory(absolute)
            .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));
          for (const name of names.sort()) {
            if (name.startsWith(".")) continue;
            const info = yield* fs
              .stat(path.join(absolute, name))
              .pipe(Effect.catchAll(() => Effect.succeed(null)));
            if (info?.type !== "File") continue;
            const summary = yield* readEntrySummary(fs, path.join(absolute, name));
            if (summary === undefined) continue;
            entries.push({
              path: `${scope}/${ALWAYS_SEGMENT}/${name}`,
              scope,
              topic: undefined,
              summary,
            });
          }
        }
        return entries;
      }.bind(this),
    );

  readonly provenance: MemoryService["provenance"] = (scopes, virtualPath) =>
    Effect.gen(
      function* (this: MemoryServiceImpl) {
        const fs = yield* FileSystem.FileSystem;
        const { scope, rest } = splitScopeAndRest(virtualPath);
        if (scope === null || !scopes.includes(scope) || !isValidStorageKey(scope)) {
          return undefined;
        }
        const scopeRoot = path.join(this.baseMemoryDirectory, scope);
        const provenance = (yield* readScopeProvenance(fs, scopeRoot)).provenance;
        return provenance.files[rest];
      }.bind(this),
    );

  readonly create: MemoryService["create"] = (scopes, virtualPath, fileText, writeContext) =>
    Effect.gen(
      function* (this: MemoryServiceImpl) {
        const resolved = this.resolveScope(scopes, virtualPath);
        if (!resolved.ok) return resolved.failure satisfies MemoryMutationOutcome;
        const { scope, rest } = resolved;

        return yield* this.withValidatedMemoryLock(
          scope,
          Effect.gen(
            function* (this: MemoryServiceImpl) {
              const fs = yield* FileSystem.FileSystem;
              const root = yield* this.ensureScopeRoot(scope);
              const target = yield* resolveMemoryPath(root, rest);

              const fileTextBytes = Buffer.byteLength(fileText, "utf-8");
              if (fileTextBytes > this.maxFileBytes) {
                return yield* Effect.fail(
                  new MemoryGuardrailViolation(
                    `File would be ${fileTextBytes} bytes, exceeding the maximum of ${this.maxFileBytes} bytes.`,
                  ),
                );
              }

              const alreadyExists = yield* fs
                .exists(target)
                .pipe(Effect.catchAll(() => Effect.succeed(false)));
              if (alreadyExists) {
                // The filename is the entry's identity, so an existing file is
                // the answer to "is this already recorded?". Returning what it
                // says turns the refusal into something the caller can act on:
                // amend the entry that exists rather than adding a second one
                // beside it, which is how a store fragments into near-duplicates.
                const existingText = yield* fs
                  .readFileString(target)
                  .pipe(Effect.catchAll(() => Effect.succeed("")));
                return {
                  success: false,
                  message: [
                    `Error: ${abbreviateHomePath(target)} already exists.`,
                    "Amend the existing entry rather than adding a second one.",
                    ...(existingText.length > 0
                      ? [
                          "",
                          "Current content:",
                          existingText.slice(0, MEMORY_SUMMARY_MAX_CHARS * 4),
                        ]
                      : []),
                  ].join("\n"),
                } satisfies MemoryMutationOutcome;
              }

              yield* this.requireScopeBudget(fs, root, {
                addedBytes: fileTextBytes,
                addsFile: true,
                subject: "Creating this file",
              });
              if (
                !(yield* prepareMemorySourceWrite(
                  fs,
                  this.baseMemoryDirectory,
                  path.join(scope, path.relative(root, target)),
                  writeContext.sourceRef,
                ))
              ) {
                return {
                  success: false,
                  message:
                    "This user statement was forgotten or superseded; cite a new user message.",
                } satisfies MemoryMutationOutcome;
              }
              yield* writeFileStringAtomic(fs, target, fileText, { tempPrefix: "memory" });
              yield* recordWrite(fs, root, path.relative(root, target), writeContext);

              return {
                success: true,
                message: `File created successfully at: ${abbreviateHomePath(target)}`,
              } satisfies MemoryMutationOutcome;
            }.bind(this),
          ),
        );
      }.bind(this),
    );

  readonly strReplace: MemoryService["strReplace"] = (
    scopes,
    virtualPath,
    oldStr,
    newStr,
    writeContext,
  ) =>
    Effect.gen(
      function* (this: MemoryServiceImpl) {
        const resolved = this.resolveScope(scopes, virtualPath);
        if (!resolved.ok) return resolved.failure satisfies MemoryMutationOutcome;
        const { scope, rest } = resolved;

        return yield* this.withValidatedMemoryLock(
          scope,
          Effect.gen(
            function* (this: MemoryServiceImpl) {
              const fs = yield* FileSystem.FileSystem;
              const root = yield* this.ensureScopeRoot(scope);
              const target = yield* resolveMemoryPath(root, rest);

              const info = yield* fs.stat(target).pipe(Effect.catchAll(() => Effect.succeed(null)));
              if (!info || info.type === "Directory") {
                return {
                  success: false,
                  message: `The path ${abbreviateHomePath(target)} does not exist. Please provide a valid path.`,
                } satisfies MemoryMutationOutcome;
              }

              const content = yield* fs
                .readFileString(target)
                .pipe(
                  Effect.catchAll((e) =>
                    Effect.fail(e instanceof Error ? e : new Error(String(e))),
                  ),
                );

              const occurrenceLines = findAllOccurrenceLineNumbers(content, oldStr);
              if (occurrenceLines.length === 0) {
                return {
                  success: false,
                  message: `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${abbreviateHomePath(target)}.`,
                } satisfies MemoryMutationOutcome;
              }
              if (occurrenceLines.length > 1) {
                return {
                  success: false,
                  message: `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${occurrenceLines.join(", ")}. Please ensure it is unique`,
                } satisfies MemoryMutationOutcome;
              }

              const replacement = newStr ?? "";
              const index = content.indexOf(oldStr);
              const updatedContent =
                content.slice(0, index) + replacement + content.slice(index + oldStr.length);

              const updatedBytes = Buffer.byteLength(updatedContent, "utf-8");
              if (updatedBytes > this.maxFileBytes) {
                return yield* Effect.fail(
                  new MemoryGuardrailViolation(
                    `Edit would grow the file to ${updatedBytes} bytes, exceeding the maximum of ${this.maxFileBytes} bytes.`,
                  ),
                );
              }

              yield* this.requireScopeBudget(fs, root, {
                addedBytes: updatedBytes - Buffer.byteLength(content, "utf-8"),
                addsFile: false,
                subject: "This edit",
              });

              if (
                !(yield* prepareMemorySourceWrite(
                  fs,
                  this.baseMemoryDirectory,
                  path.join(scope, path.relative(root, target)),
                  writeContext.sourceRef,
                ))
              ) {
                return {
                  success: false,
                  message:
                    "This user statement was forgotten or superseded; cite a new user message.",
                } satisfies MemoryMutationOutcome;
              }

              yield* writeFileStringAtomic(fs, target, updatedContent, { tempPrefix: "memory" });
              yield* recordWrite(fs, root, path.relative(root, target), writeContext);

              return {
                success: true,
                message: "The memory file has been edited.",
              } satisfies MemoryMutationOutcome;
            }.bind(this),
          ),
        );
      }.bind(this),
    );

  readonly insert: MemoryService["insert"] = (
    scopes,
    virtualPath,
    insertLine,
    insertText,
    writeContext,
  ) =>
    Effect.gen(
      function* (this: MemoryServiceImpl) {
        const resolved = this.resolveScope(scopes, virtualPath);
        if (!resolved.ok) return resolved.failure satisfies MemoryMutationOutcome;
        const { scope, rest } = resolved;

        return yield* this.withValidatedMemoryLock(
          scope,
          Effect.gen(
            function* (this: MemoryServiceImpl) {
              const fs = yield* FileSystem.FileSystem;
              const root = yield* this.ensureScopeRoot(scope);
              const target = yield* resolveMemoryPath(root, rest);

              const info = yield* fs.stat(target).pipe(Effect.catchAll(() => Effect.succeed(null)));
              if (!info || info.type === "Directory") {
                return {
                  success: false,
                  message: `Error: The path ${abbreviateHomePath(target)} does not exist`,
                } satisfies MemoryMutationOutcome;
              }

              const content = yield* fs
                .readFileString(target)
                .pipe(
                  Effect.catchAll((e) =>
                    Effect.fail(e instanceof Error ? e : new Error(String(e))),
                  ),
                );
              const lines = content.split("\n");

              if (insertLine < 0 || insertLine > lines.length) {
                return {
                  success: false,
                  message: `Error: Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`,
                } satisfies MemoryMutationOutcome;
              }

              const updatedLines = [
                ...lines.slice(0, insertLine),
                ...insertText.split("\n"),
                ...lines.slice(insertLine),
              ];
              const updatedContent = updatedLines.join("\n");

              const updatedBytes = Buffer.byteLength(updatedContent, "utf-8");
              if (updatedBytes > this.maxFileBytes) {
                return yield* Effect.fail(
                  new MemoryGuardrailViolation(
                    `Edit would grow the file to ${updatedBytes} bytes, exceeding the maximum of ${this.maxFileBytes} bytes.`,
                  ),
                );
              }

              yield* this.requireScopeBudget(fs, root, {
                addedBytes: updatedBytes - Buffer.byteLength(content, "utf-8"),
                addsFile: false,
                subject: "This edit",
              });

              if (
                !(yield* prepareMemorySourceWrite(
                  fs,
                  this.baseMemoryDirectory,
                  path.join(scope, path.relative(root, target)),
                  writeContext.sourceRef,
                ))
              ) {
                return {
                  success: false,
                  message:
                    "This user statement was forgotten or superseded; cite a new user message.",
                } satisfies MemoryMutationOutcome;
              }

              yield* writeFileStringAtomic(fs, target, updatedContent, { tempPrefix: "memory" });
              yield* recordWrite(fs, root, path.relative(root, target), writeContext);

              return {
                success: true,
                message: `The file ${abbreviateHomePath(target)} has been edited.`,
              } satisfies MemoryMutationOutcome;
            }.bind(this),
          ),
        );
      }.bind(this),
    );

  readonly delete: MemoryService["delete"] = (scopes, virtualPath) =>
    Effect.gen(
      function* (this: MemoryServiceImpl) {
        const resolved = this.resolveScope(scopes, virtualPath);
        if (!resolved.ok) return resolved.failure satisfies MemoryMutationOutcome;
        const { scope, rest } = resolved;

        return yield* this.withValidatedMemoryLock(
          scope,
          Effect.gen(
            function* (this: MemoryServiceImpl) {
              const fs = yield* FileSystem.FileSystem;
              const root = yield* this.ensureScopeRoot(scope);
              const target = yield* resolveMemoryPath(root, rest);

              if (target === root) {
                return {
                  success: false,
                  message: "Error: cannot delete a scope's memory root",
                } satisfies MemoryMutationOutcome;
              }

              const exists = yield* fs
                .exists(target)
                .pipe(Effect.catchAll(() => Effect.succeed(false)));
              if (!exists) {
                return {
                  success: false,
                  message: `Error: The path ${abbreviateHomePath(target)} does not exist`,
                } satisfies MemoryMutationOutcome;
              }

              yield* prepareMemorySourceDelete(
                fs,
                this.baseMemoryDirectory,
                path.join(scope, path.relative(root, target)),
              );
              yield* fs
                .remove(target, { recursive: true })
                .pipe(
                  Effect.catchAll((e) =>
                    Effect.fail(e instanceof Error ? e : new Error(String(e))),
                  ),
                );

              yield* forgetProvenance(fs, root, path.relative(root, target));

              return {
                success: true,
                message: `Successfully deleted ${abbreviateHomePath(target)}`,
              } satisfies MemoryMutationOutcome;
            }.bind(this),
          ),
        );
      }.bind(this),
    );

  readonly rename: MemoryService["rename"] = (
    scopes,
    oldVirtualPath,
    newVirtualPath,
    writeContext,
  ) =>
    Effect.gen(
      function* (this: MemoryServiceImpl) {
        const resolvedOld = this.resolveScope(scopes, oldVirtualPath);
        if (!resolvedOld.ok) return resolvedOld.failure satisfies MemoryMutationOutcome;
        const resolvedNew = this.resolveScope(scopes, newVirtualPath);
        if (!resolvedNew.ok) return resolvedNew.failure satisfies MemoryMutationOutcome;

        if (resolvedOld.scope !== resolvedNew.scope) {
          return {
            success: false,
            message: `Error: cannot rename across memory scopes ("${resolvedOld.scope}" to "${resolvedNew.scope}"). Move the content with view_memory/create instead.`,
          } satisfies MemoryMutationOutcome;
        }
        const scope = resolvedOld.scope;

        return yield* this.withValidatedMemoryLock(
          scope,
          Effect.gen(
            function* (this: MemoryServiceImpl) {
              const fs = yield* FileSystem.FileSystem;
              const root = yield* this.ensureScopeRoot(scope);
              const source = yield* resolveMemoryPath(root, resolvedOld.rest);
              const destination = yield* resolveMemoryPath(root, resolvedNew.rest);

              if (source === root || destination === root) {
                return {
                  success: false,
                  message: "Error: cannot rename a scope's memory root",
                } satisfies MemoryMutationOutcome;
              }

              const sourceExists = yield* fs
                .exists(source)
                .pipe(Effect.catchAll(() => Effect.succeed(false)));
              if (!sourceExists) {
                return {
                  success: false,
                  message: `Error: The path ${abbreviateHomePath(source)} does not exist`,
                } satisfies MemoryMutationOutcome;
              }

              const destinationExists = yield* fs
                .exists(destination)
                .pipe(Effect.catchAll(() => Effect.succeed(false)));
              if (destinationExists) {
                return {
                  success: false,
                  message: `Error: The destination ${abbreviateHomePath(destination)} already exists`,
                } satisfies MemoryMutationOutcome;
              }

              yield* fs
                .makeDirectory(path.dirname(destination), { recursive: true })
                .pipe(
                  Effect.catchAll((e) =>
                    Effect.fail(e instanceof Error ? e : new Error(String(e))),
                  ),
                );
              yield* prepareMemorySourceRename(
                fs,
                this.baseMemoryDirectory,
                path.join(scope, path.relative(root, source)),
                path.join(scope, path.relative(root, destination)),
              );
              yield* fs
                .rename(source, destination)
                .pipe(
                  Effect.catchAll((e) =>
                    Effect.fail(e instanceof Error ? e : new Error(String(e))),
                  ),
                );

              yield* moveProvenance(
                fs,
                root,
                path.relative(root, source),
                path.relative(root, destination),
                writeContext,
              );

              return {
                success: true,
                message: `Successfully renamed ${abbreviateHomePath(source)} to ${abbreviateHomePath(destination)}`,
              } satisfies MemoryMutationOutcome;
            }.bind(this),
          ),
        );
      }.bind(this),
    );
}

export function createMemoryServiceLayer(
  options?: MemoryServiceImplOptions,
): Layer.Layer<MemoryService> {
  return Layer.succeed(MemoryServiceTag, new MemoryServiceImpl(options));
}
