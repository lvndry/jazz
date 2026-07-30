import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect, Layer } from "effect";
import {
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_FILES_PER_AGENT,
  MAX_MEMORY_PATH_DEPTH,
  MAX_MEMORY_PATH_SEGMENT_LENGTH,
  MAX_MEMORY_TOTAL_BYTES_PER_AGENT,
  MEMORY_VIEW_MAX_LINES,
  MEMORY_VIEW_TRUNCATE_CHARS,
} from "@/core/constants/memory";
import type {
  MemoryDirectoryEntry,
  MemoryMutationOutcome,
  MemoryService,
  MemoryViewOutcome,
} from "@/core/interfaces/memory-service";
import { MemoryServiceTag } from "@/core/interfaces/memory-service";
import { withLock } from "@/core/utils/file-lock";
import { getMemoryDirectory } from "@/core/utils/runtime-detection";

/** Raised for path-safety and guardrail violations — genuinely unexpected conditions, not tool-result-shaped errors. */
export class MemoryPathViolation extends Error {}

const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function requireValidAgentId(agentId: string): Effect.Effect<void, MemoryPathViolation> {
  return AGENT_ID_PATTERN.test(agentId)
    ? Effect.void
    : Effect.fail(new MemoryPathViolation(`Invalid agent id: "${agentId}".`));
}

function displayPath(virtualPath: string): string {
  const trimmed = virtualPath.trim();
  if (trimmed.length === 0 || trimmed === "/") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Split an LLM-supplied virtual path into safe segments. Never treats a
 * leading "/" as an OS-absolute escape — the whole string is relative to a
 * fixed virtual root, matching Anthropic's own /memories convention rather
 * than Node's absolute-path semantics.
 */
function splitVirtualPathIntoSegments(virtualPath: string): string[] {
  if (virtualPath.includes("\0")) {
    throw new MemoryPathViolation("Path contains a null byte.");
  }

  const normalized = virtualPath.normalize("NFC");
  const withoutLeadingSlashes = normalized.replace(/^\/+/, "");

  if (withoutLeadingSlashes.length === 0) return [];

  if (withoutLeadingSlashes.includes("\\")) {
    throw new MemoryPathViolation("Path must not contain backslashes.");
  }

  const segments = withoutLeadingSlashes.split("/");
  if (segments.length > MAX_MEMORY_PATH_DEPTH) {
    throw new MemoryPathViolation(
      `Path depth ${segments.length} exceeds the maximum of ${MAX_MEMORY_PATH_DEPTH}.`,
    );
  }

  for (const segment of segments) {
    if (segment.length === 0) {
      throw new MemoryPathViolation('Path must not contain empty segments ("//").');
    }
    if (segment === "." || segment === "..") {
      throw new MemoryPathViolation(`Path segment "${segment}" is not allowed.`);
    }
    if (segment.length > MAX_MEMORY_PATH_SEGMENT_LENGTH) {
      throw new MemoryPathViolation(
        `Path segment exceeds the maximum length of ${MAX_MEMORY_PATH_SEGMENT_LENGTH}.`,
      );
    }
  }

  return segments;
}

function parseVirtualPath(virtualPath: string): Effect.Effect<string[], MemoryPathViolation> {
  return Effect.try({
    try: () => splitVirtualPathIntoSegments(virtualPath),
    catch: (error) =>
      error instanceof MemoryPathViolation ? error : new MemoryPathViolation(String(error)),
  });
}

/** True if `candidatePath` exists and is a symlink. Non-existent paths are not symlinks. */
function isSymlink(candidatePath: string): Effect.Effect<boolean> {
  return Effect.tryPromise({
    try: () => nodeFs.lstat(candidatePath),
    catch: (error) => error,
  }).pipe(
    Effect.map((stat) => stat.isSymbolicLink()),
    Effect.catchAll(() => Effect.succeed(false)),
  );
}

/**
 * The single choke point every memory action goes through before touching
 * the filesystem. Bans symlinks outright — re-checked on every call (not
 * cached), so a same-run "create a file, swap it for a symlink via another
 * tool, then read/delete through it" race is closed rather than exploitable.
 */
function resolveMemoryPath(
  memoryRoot: string,
  virtualPath: string,
): Effect.Effect<string, MemoryPathViolation> {
  return Effect.gen(function* () {
    const segments = yield* parseVirtualPath(virtualPath);

    const candidate = segments.length === 0 ? memoryRoot : path.join(memoryRoot, ...segments);
    const normalizedCandidate = path.normalize(candidate);
    const rootWithSep = memoryRoot.endsWith(path.sep) ? memoryRoot : memoryRoot + path.sep;
    if (normalizedCandidate !== memoryRoot && !normalizedCandidate.startsWith(rootWithSep)) {
      return yield* Effect.fail(
        new MemoryPathViolation("Resolved path escapes the agent's memory root."),
      );
    }

    let walked = memoryRoot;
    for (const segment of segments) {
      walked = path.join(walked, segment);
      const symlink = yield* isSymlink(walked);
      if (symlink) {
        return yield* Effect.fail(
          new MemoryPathViolation(
            `Path component "${segment}" is a symlink; symlinks are not allowed under the memory root.`,
          ),
        );
      }
    }

    return normalizedCandidate;
  });
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

function writeFileAtomic(
  fs: FileSystem.FileSystem,
  targetPath: string,
  content: string,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const directory = path.dirname(targetPath);
    const tmpPath = path.join(
      directory,
      `.memory-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );

    yield* fs
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))));
    yield* fs
      .writeFileString(tmpPath, content)
      .pipe(Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))));
    yield* fs.rename(tmpPath, targetPath).pipe(
      Effect.tapError(() => fs.remove(tmpPath).pipe(Effect.catchAll(() => Effect.void))),
      Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))),
    );
  });
}

/** Byte offset of the start of each line, for O(log N) offset→line lookups (mirrors edit.ts's approval-preview technique). */
function buildLineOffsets(content: string): number[] {
  const lineOffsets: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") lineOffsets.push(i + 1);
  }
  return lineOffsets;
}

function offsetToLine(lineOffsets: readonly number[], offset: number): number {
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if ((lineOffsets[mid] as number) <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1;
}

function findAllOccurrenceLineNumbers(content: string, searchStr: string): number[] {
  const lineOffsets = buildLineOffsets(content);
  const lineNumbers: number[] = [];
  let index = 0;
  while ((index = content.indexOf(searchStr, index)) !== -1) {
    lineNumbers.push(offsetToLine(lineOffsets, index));
    index += Math.max(searchStr.length, 1);
  }
  return lineNumbers;
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
  ): Effect.Effect<string, MemoryPathViolation | Error, FileSystem.FileSystem> {
    const baseMemoryDirectory = this.baseMemoryDirectory;
    return Effect.gen(function* () {
      yield* requireValidAgentId(agentId);
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
  ): Effect.Effect<A, E | MemoryPathViolation | Error, R | FileSystem.FileSystem> {
    const lockPath = this.memoryLockPath(agentId);
    return Effect.gen(function* () {
      yield* requireValidAgentId(agentId);
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
            message: `The path ${displayPath(virtualPath)} does not exist. Please provide a valid path.`,
          } satisfies MemoryViewOutcome;
        }

        if (info.type === "Directory") {
          const entries = yield* listDirectoryEntries(fs, target, 2);
          return {
            kind: "directory",
            path: displayPath(virtualPath),
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
            message: `File ${displayPath(virtualPath)} exceeds maximum line limit of ${MEMORY_VIEW_MAX_LINES.toLocaleString()} lines.`,
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
          path: displayPath(virtualPath),
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
              new MemoryPathViolation(
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
              message: `Error: File ${displayPath(virtualPath)} already exists`,
            } satisfies MemoryMutationOutcome;
          }

          const stats = yield* walkMemoryTree(fs, root);
          if (stats.fileCount + 1 > MAX_MEMORY_FILES_PER_AGENT) {
            return yield* Effect.fail(
              new MemoryPathViolation(
                `Creating this file would exceed the maximum of ${MAX_MEMORY_FILES_PER_AGENT} files in memory.`,
              ),
            );
          }
          if (stats.totalBytes + fileTextBytes > MAX_MEMORY_TOTAL_BYTES_PER_AGENT) {
            return yield* Effect.fail(
              new MemoryPathViolation(
                `Creating this file would exceed the total memory budget of ${MAX_MEMORY_TOTAL_BYTES_PER_AGENT} bytes.`,
              ),
            );
          }

          yield* writeFileAtomic(fs, target, fileText);

          return {
            success: true,
            message: `File created successfully at: ${displayPath(virtualPath)}`,
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
              message: `The path ${displayPath(virtualPath)} does not exist. Please provide a valid path.`,
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
              message: `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${displayPath(virtualPath)}.`,
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
              new MemoryPathViolation(
                `Edit would grow the file to ${updatedBytes} bytes, exceeding the maximum of ${MAX_MEMORY_FILE_BYTES} bytes.`,
              ),
            );
          }

          yield* writeFileAtomic(fs, target, updatedContent);

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
              message: `Error: The path ${displayPath(virtualPath)} does not exist`,
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
              new MemoryPathViolation(
                `Edit would grow the file to ${updatedBytes} bytes, exceeding the maximum of ${MAX_MEMORY_FILE_BYTES} bytes.`,
              ),
            );
          }

          yield* writeFileAtomic(fs, target, updatedContent);

          return {
            success: true,
            message: `The file ${displayPath(virtualPath)} has been edited.`,
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
              message: `Error: The path ${displayPath(virtualPath)} does not exist`,
            } satisfies MemoryMutationOutcome;
          }

          yield* fs
            .remove(target, { recursive: true })
            .pipe(
              Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))),
            );

          return {
            success: true,
            message: `Successfully deleted ${displayPath(virtualPath)}`,
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
              message: `Error: The path ${displayPath(oldVirtualPath)} does not exist`,
            } satisfies MemoryMutationOutcome;
          }

          const destinationExists = yield* fs
            .exists(destination)
            .pipe(Effect.catchAll(() => Effect.succeed(false)));
          if (destinationExists) {
            return {
              success: false,
              message: `Error: The destination ${displayPath(newVirtualPath)} already exists`,
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
            message: `Successfully renamed ${displayPath(oldVirtualPath)} to ${displayPath(newVirtualPath)}`,
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
