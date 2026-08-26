import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import {
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_FILES_PER_AGENT,
  MAX_MEMORY_PATH_DEPTH,
  MAX_MEMORY_PATH_SEGMENT_LENGTH,
  MAX_MEMORY_TOTAL_BYTES_PER_AGENT,
  MEMORY_VIEW_MAX_LINES,
  MEMORY_VIEW_TRUNCATE_CHARS,
} from "@jazz/core/constants/memory";
import type {
  MemoryDirectoryEntry,
  MemoryMutationOutcome,
  MemoryService,
  MemoryViewOutcome,
} from "@jazz/core/interfaces/memory-service";
import { MemoryServiceTag } from "@jazz/core/interfaces/memory-service";
import { getMemoryDirectory } from "@jazz/core/utils/paths";
import {
  abbreviateHomePath,
  requireValidAgentId,
  withLock,
  writeFileStringAtomic,
} from "@jazz/core/utils/storage";
import { findAllOccurrenceLineNumbers } from "@jazz/core/utils/string";
import { resolveVirtualPath, type VirtualPathViolation } from "@jazz/core/utils/virtual-path";
import { Effect, Layer } from "effect";

/** Raised for memory quota and agent-scoping guardrail violations. */
export class MemoryGuardrailViolation extends Error {}

const MEMORY_PATH_OPTIONS = {
  maxDepth: MAX_MEMORY_PATH_DEPTH,
  maxSegmentLength: MAX_MEMORY_PATH_SEGMENT_LENGTH,
} as const;

function resolveMemoryPath(
  memoryRoot: string,
  virtualPath: string,
): Effect.Effect<string, VirtualPathViolation | Error> {
  return resolveVirtualPath(memoryRoot, virtualPath, MEMORY_PATH_OPTIONS);
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

export interface MemoryServiceImplOptions {
  /** Override for tests; defaults to ~/.jazz/memory (or $JAZZ_HOME/memory). */
  readonly baseMemoryDirectory?: string;
}

export class MemoryServiceImpl implements MemoryService {
  private readonly baseMemoryDirectory: string;

  constructor(options?: MemoryServiceImplOptions) {
    this.baseMemoryDirectory = options?.baseMemoryDirectory ?? getMemoryDirectory();
  }

  private memoryLockPath(agentId: string): string {
    return path.join(this.baseMemoryDirectory, `${agentId}.lock`);
  }

  private ensureAgentRoot(
    agentId: string,
  ): Effect.Effect<string, MemoryGuardrailViolation | Error, FileSystem.FileSystem> {
    const baseMemoryDirectory = this.baseMemoryDirectory;
    return Effect.gen(function* () {
      yield* requireValidAgentId(agentId, MemoryGuardrailViolation);
      const fs = yield* FileSystem.FileSystem;
      const rawRoot = path.join(baseMemoryDirectory, agentId);
      yield* fs
        .makeDirectory(rawRoot, { recursive: true })
        .pipe(Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))));
      return yield* Effect.tryPromise({
        try: () => nodeFs.realpath(rawRoot),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      });
    });
  }

  private withValidatedAgentLock<A, E, R>(
    agentId: string,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | MemoryGuardrailViolation | Error, R | FileSystem.FileSystem> {
    const lockPath = this.memoryLockPath(agentId);
    return Effect.gen(function* () {
      yield* requireValidAgentId(agentId, MemoryGuardrailViolation);
      return yield* withLock(lockPath, operation);
    });
  }

  readonly view: MemoryService["view"] = (agentId, virtualPath, viewRange) =>
    Effect.gen(
      function* (this: MemoryServiceImpl) {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* this.ensureAgentRoot(agentId);
        const target = yield* resolveMemoryPath(root, virtualPath);

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

  readonly create: MemoryService["create"] = (agentId, virtualPath, fileText) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: MemoryServiceImpl) {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* this.ensureAgentRoot(agentId);
          const target = yield* resolveMemoryPath(root, virtualPath);

          const fileTextBytes = Buffer.byteLength(fileText, "utf-8");
          if (fileTextBytes > MAX_MEMORY_FILE_BYTES) {
            return yield* Effect.fail(
              new MemoryGuardrailViolation(
                `File would be ${fileTextBytes} bytes, exceeding the maximum of ${MAX_MEMORY_FILE_BYTES} bytes.`,
              ),
            );
          }

          const alreadyExists = yield* fs
            .exists(target)
            .pipe(Effect.catchAll(() => Effect.succeed(false)));
          if (alreadyExists) {
            return {
              success: false,
              message: `Error: File ${abbreviateHomePath(target)} already exists`,
            } satisfies MemoryMutationOutcome;
          }

          const stats = yield* walkMemoryTree(fs, root);
          if (stats.fileCount + 1 > MAX_MEMORY_FILES_PER_AGENT) {
            return yield* Effect.fail(
              new MemoryGuardrailViolation(
                `Creating this file would exceed the maximum of ${MAX_MEMORY_FILES_PER_AGENT} files in memory.`,
              ),
            );
          }
          if (stats.totalBytes + fileTextBytes > MAX_MEMORY_TOTAL_BYTES_PER_AGENT) {
            return yield* Effect.fail(
              new MemoryGuardrailViolation(
                `Creating this file would exceed the total memory budget of ${MAX_MEMORY_TOTAL_BYTES_PER_AGENT} bytes.`,
              ),
            );
          }

          yield* writeFileStringAtomic(fs, target, fileText, { tempPrefix: "memory" });

          return {
            success: true,
            message: `File created successfully at: ${abbreviateHomePath(target)}`,
          } satisfies MemoryMutationOutcome;
        }.bind(this),
      ),
    );

  readonly strReplace: MemoryService["strReplace"] = (agentId, virtualPath, oldStr, newStr) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: MemoryServiceImpl) {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* this.ensureAgentRoot(agentId);
          const target = yield* resolveMemoryPath(root, virtualPath);

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
              Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))),
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
          if (updatedBytes > MAX_MEMORY_FILE_BYTES) {
            return yield* Effect.fail(
              new MemoryGuardrailViolation(
                `Edit would grow the file to ${updatedBytes} bytes, exceeding the maximum of ${MAX_MEMORY_FILE_BYTES} bytes.`,
              ),
            );
          }

          yield* writeFileStringAtomic(fs, target, updatedContent, { tempPrefix: "memory" });

          return {
            success: true,
            message: "The memory file has been edited.",
          } satisfies MemoryMutationOutcome;
        }.bind(this),
      ),
    );

  readonly insert: MemoryService["insert"] = (agentId, virtualPath, insertLine, insertText) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: MemoryServiceImpl) {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* this.ensureAgentRoot(agentId);
          const target = yield* resolveMemoryPath(root, virtualPath);

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
              Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))),
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
          if (updatedBytes > MAX_MEMORY_FILE_BYTES) {
            return yield* Effect.fail(
              new MemoryGuardrailViolation(
                `Edit would grow the file to ${updatedBytes} bytes, exceeding the maximum of ${MAX_MEMORY_FILE_BYTES} bytes.`,
              ),
            );
          }

          yield* writeFileStringAtomic(fs, target, updatedContent, { tempPrefix: "memory" });

          return {
            success: true,
            message: `The file ${abbreviateHomePath(target)} has been edited.`,
          } satisfies MemoryMutationOutcome;
        }.bind(this),
      ),
    );

  readonly delete: MemoryService["delete"] = (agentId, virtualPath) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: MemoryServiceImpl) {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* this.ensureAgentRoot(agentId);
          const target = yield* resolveMemoryPath(root, virtualPath);

          if (target === root) {
            return {
              success: false,
              message: "Error: cannot delete your memory root",
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

          yield* fs
            .remove(target, { recursive: true })
            .pipe(
              Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))),
            );

          return {
            success: true,
            message: `Successfully deleted ${abbreviateHomePath(target)}`,
          } satisfies MemoryMutationOutcome;
        }.bind(this),
      ),
    );

  readonly rename: MemoryService["rename"] = (agentId, oldVirtualPath, newVirtualPath) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: MemoryServiceImpl) {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* this.ensureAgentRoot(agentId);
          const source = yield* resolveMemoryPath(root, oldVirtualPath);
          const destination = yield* resolveMemoryPath(root, newVirtualPath);

          if (source === root || destination === root) {
            return {
              success: false,
              message: "Error: cannot rename your memory root",
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
              Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))),
            );
          yield* fs
            .rename(source, destination)
            .pipe(
              Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))),
            );

          return {
            success: true,
            message: `Successfully renamed ${abbreviateHomePath(source)} to ${abbreviateHomePath(destination)}`,
          } satisfies MemoryMutationOutcome;
        }.bind(this),
      ),
    );
}

export function createMemoryServiceLayer(
  options?: MemoryServiceImplOptions,
): Layer.Layer<MemoryService> {
  return Layer.succeed(MemoryServiceTag, new MemoryServiceImpl(options));
}
