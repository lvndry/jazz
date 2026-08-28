/**
 * Implements `WorkspaceService`: an agent's durable scratch space, stored as files under a
 * per-agent workspace directory with path and quota guardrails enforced here.
 */

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import {
  DEFAULT_MAX_WORKSPACE_TOTAL_BYTES_PER_AGENT,
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_FILES_PER_AGENT,
  MAX_WORKSPACE_PATH_DEPTH,
  MAX_WORKSPACE_PATH_SEGMENT_LENGTH,
  WORKSPACE_VIEW_MAX_LINES,
  WORKSPACE_VIEW_TRUNCATE_CHARS,
} from "@jazz/core/constants/workspace";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type {
  WorkspaceDirectoryEntry,
  WorkspaceMutationOutcome,
  WorkspaceService,
  WorkspaceViewOutcome,
} from "@jazz/core/interfaces/workspace-service";
import { WorkspaceServiceTag } from "@jazz/core/interfaces/workspace-service";
import { getWorkspaceDirectory } from "@jazz/core/utils/paths";
import {
  abbreviateHomePath,
  requireValidAgentId,
  withLock,
  writeFileStringAtomic,
} from "@jazz/core/utils/storage";
import { findAllOccurrenceLineNumbers } from "@jazz/core/utils/string";
import { resolveVirtualPath, type VirtualPathViolation } from "@jazz/core/utils/virtual-path";
import { Effect, Layer } from "effect";

/** Raised for workspace quota and agent-scoping guardrail violations. */
export class WorkspaceGuardrailViolation extends Error {}

const WORKSPACE_PATH_OPTIONS = {
  maxDepth: MAX_WORKSPACE_PATH_DEPTH,
  maxSegmentLength: MAX_WORKSPACE_PATH_SEGMENT_LENGTH,
} as const;

function resolveWorkspacePath(
  workspaceRoot: string,
  virtualPath: string,
): Effect.Effect<string, VirtualPathViolation | Error> {
  return resolveVirtualPath(workspaceRoot, virtualPath, WORKSPACE_PATH_OPTIONS);
}

interface WorkspaceTreeStats {
  readonly totalBytes: number;
  readonly fileCount: number;
}

function walkWorkspaceTree(
  fs: FileSystem.FileSystem,
  dir: string,
): Effect.Effect<WorkspaceTreeStats, Error> {
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
        const nested = yield* walkWorkspaceTree(fs, entryPath);
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
): Effect.Effect<WorkspaceDirectoryEntry[], Error> {
  return Effect.gen(function* () {
    const names = yield* fs
      .readDirectory(dir)
      .pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));
    const visible = names.filter((name) => !name.startsWith(".")).sort();

    const entries: WorkspaceDirectoryEntry[] = [];
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

export interface WorkspaceServiceImplOptions {
  /** Override for tests; defaults to ~/.jazz/workspace (or $JAZZ_HOME/workspace). */
  readonly baseWorkspaceDirectory?: string;
  /** Per-agent total size cap, in bytes; defaults to `DEFAULT_MAX_WORKSPACE_TOTAL_BYTES_PER_AGENT`. */
  readonly maxTotalBytesPerAgent?: number;
}

export class WorkspaceServiceImpl implements WorkspaceService {
  private readonly baseWorkspaceDirectory: string;
  private readonly maxTotalBytesPerAgent: number;

  constructor(options?: WorkspaceServiceImplOptions) {
    this.baseWorkspaceDirectory = options?.baseWorkspaceDirectory ?? getWorkspaceDirectory();
    this.maxTotalBytesPerAgent =
      options?.maxTotalBytesPerAgent ?? DEFAULT_MAX_WORKSPACE_TOTAL_BYTES_PER_AGENT;
  }

  private workspaceLockPath(agentId: string): string {
    return path.join(this.baseWorkspaceDirectory, `${agentId}.lock`);
  }

  private ensureAgentRoot(
    agentId: string,
  ): Effect.Effect<string, WorkspaceGuardrailViolation | Error, FileSystem.FileSystem> {
    const baseWorkspaceDirectory = this.baseWorkspaceDirectory;
    return Effect.gen(function* () {
      yield* requireValidAgentId(agentId, WorkspaceGuardrailViolation);
      const fs = yield* FileSystem.FileSystem;
      const rawRoot = path.join(baseWorkspaceDirectory, agentId);
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
  ): Effect.Effect<A, E | WorkspaceGuardrailViolation | Error, R | FileSystem.FileSystem> {
    const lockPath = this.workspaceLockPath(agentId);
    return Effect.gen(function* () {
      yield* requireValidAgentId(agentId, WorkspaceGuardrailViolation);
      return yield* withLock(lockPath, operation);
    });
  }

  readonly view: WorkspaceService["view"] = (agentId, virtualPath, viewRange) =>
    Effect.gen(
      function* (this: WorkspaceServiceImpl) {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* this.ensureAgentRoot(agentId);
        const target = yield* resolveWorkspacePath(root, virtualPath);

        const info = yield* fs.stat(target).pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (!info) {
          return {
            kind: "not_found",
            message: `The path ${abbreviateHomePath(target)} does not exist. Please provide a valid path.`,
          } satisfies WorkspaceViewOutcome;
        }

        if (info.type === "Directory") {
          const entries = yield* listDirectoryEntries(fs, target, 2);
          return {
            kind: "directory",
            path: abbreviateHomePath(target),
            entries,
          } satisfies WorkspaceViewOutcome;
        }

        const content = yield* fs
          .readFileString(target)
          .pipe(Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))));
        const lines = content.split("\n");
        const totalLines = lines.length;

        if (totalLines > WORKSPACE_VIEW_MAX_LINES) {
          return {
            kind: "too_large",
            message: `File ${abbreviateHomePath(target)} exceeds maximum line limit of ${WORKSPACE_VIEW_MAX_LINES.toLocaleString()} lines.`,
          } satisfies WorkspaceViewOutcome;
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
        const truncated = selected.length > WORKSPACE_VIEW_TRUNCATE_CHARS;
        const displayContent = truncated
          ? selected.slice(0, WORKSPACE_VIEW_TRUNCATE_CHARS)
          : selected;

        return {
          kind: "file",
          path: abbreviateHomePath(target),
          content: displayContent,
          startLine,
          totalLines,
          truncated,
        } satisfies WorkspaceViewOutcome;
      }.bind(this),
    );

  readonly create: WorkspaceService["create"] = (agentId, virtualPath, fileText) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: WorkspaceServiceImpl) {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* this.ensureAgentRoot(agentId);
          const target = yield* resolveWorkspacePath(root, virtualPath);

          const fileTextBytes = Buffer.byteLength(fileText, "utf-8");
          if (fileTextBytes > MAX_WORKSPACE_FILE_BYTES) {
            return yield* Effect.fail(
              new WorkspaceGuardrailViolation(
                `File would be ${fileTextBytes} bytes, exceeding the maximum of ${MAX_WORKSPACE_FILE_BYTES} bytes.`,
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
            } satisfies WorkspaceMutationOutcome;
          }

          const stats = yield* walkWorkspaceTree(fs, root);
          if (stats.fileCount + 1 > MAX_WORKSPACE_FILES_PER_AGENT) {
            return yield* Effect.fail(
              new WorkspaceGuardrailViolation(
                `Creating this file would exceed the maximum of ${MAX_WORKSPACE_FILES_PER_AGENT} files in workspace.`,
              ),
            );
          }
          if (stats.totalBytes + fileTextBytes > this.maxTotalBytesPerAgent) {
            return yield* Effect.fail(
              new WorkspaceGuardrailViolation(
                `Creating this file would exceed the total workspace budget of ${this.maxTotalBytesPerAgent} bytes.`,
              ),
            );
          }

          yield* writeFileStringAtomic(fs, target, fileText, { tempPrefix: "workspace" });

          return {
            success: true,
            message: `File created successfully at: ${abbreviateHomePath(target)}`,
          } satisfies WorkspaceMutationOutcome;
        }.bind(this),
      ),
    );

  readonly strReplace: WorkspaceService["strReplace"] = (agentId, virtualPath, oldStr, newStr) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: WorkspaceServiceImpl) {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* this.ensureAgentRoot(agentId);
          const target = yield* resolveWorkspacePath(root, virtualPath);

          const info = yield* fs.stat(target).pipe(Effect.catchAll(() => Effect.succeed(null)));
          if (!info || info.type === "Directory") {
            return {
              success: false,
              message: `The path ${abbreviateHomePath(target)} does not exist. Please provide a valid path.`,
            } satisfies WorkspaceMutationOutcome;
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
            } satisfies WorkspaceMutationOutcome;
          }
          if (occurrenceLines.length > 1) {
            return {
              success: false,
              message: `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${occurrenceLines.join(", ")}. Please ensure it is unique`,
            } satisfies WorkspaceMutationOutcome;
          }

          const replacement = newStr ?? "";
          const index = content.indexOf(oldStr);
          const updatedContent =
            content.slice(0, index) + replacement + content.slice(index + oldStr.length);

          const updatedBytes = Buffer.byteLength(updatedContent, "utf-8");
          if (updatedBytes > MAX_WORKSPACE_FILE_BYTES) {
            return yield* Effect.fail(
              new WorkspaceGuardrailViolation(
                `Edit would grow the file to ${updatedBytes} bytes, exceeding the maximum of ${MAX_WORKSPACE_FILE_BYTES} bytes.`,
              ),
            );
          }

          yield* writeFileStringAtomic(fs, target, updatedContent, { tempPrefix: "workspace" });

          return {
            success: true,
            message: "The workspace file has been edited.",
          } satisfies WorkspaceMutationOutcome;
        }.bind(this),
      ),
    );

  readonly insert: WorkspaceService["insert"] = (agentId, virtualPath, insertLine, insertText) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: WorkspaceServiceImpl) {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* this.ensureAgentRoot(agentId);
          const target = yield* resolveWorkspacePath(root, virtualPath);

          const info = yield* fs.stat(target).pipe(Effect.catchAll(() => Effect.succeed(null)));
          if (!info || info.type === "Directory") {
            return {
              success: false,
              message: `Error: The path ${abbreviateHomePath(target)} does not exist`,
            } satisfies WorkspaceMutationOutcome;
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
            } satisfies WorkspaceMutationOutcome;
          }

          const updatedLines = [
            ...lines.slice(0, insertLine),
            ...insertText.split("\n"),
            ...lines.slice(insertLine),
          ];
          const updatedContent = updatedLines.join("\n");

          const updatedBytes = Buffer.byteLength(updatedContent, "utf-8");
          if (updatedBytes > MAX_WORKSPACE_FILE_BYTES) {
            return yield* Effect.fail(
              new WorkspaceGuardrailViolation(
                `Edit would grow the file to ${updatedBytes} bytes, exceeding the maximum of ${MAX_WORKSPACE_FILE_BYTES} bytes.`,
              ),
            );
          }

          yield* writeFileStringAtomic(fs, target, updatedContent, { tempPrefix: "workspace" });

          return {
            success: true,
            message: `The file ${abbreviateHomePath(target)} has been edited.`,
          } satisfies WorkspaceMutationOutcome;
        }.bind(this),
      ),
    );

  readonly delete: WorkspaceService["delete"] = (agentId, virtualPath) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: WorkspaceServiceImpl) {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* this.ensureAgentRoot(agentId);
          const target = yield* resolveWorkspacePath(root, virtualPath);

          if (target === root) {
            return {
              success: false,
              message: "Error: cannot delete your workspace root",
            } satisfies WorkspaceMutationOutcome;
          }

          const exists = yield* fs
            .exists(target)
            .pipe(Effect.catchAll(() => Effect.succeed(false)));
          if (!exists) {
            return {
              success: false,
              message: `Error: The path ${abbreviateHomePath(target)} does not exist`,
            } satisfies WorkspaceMutationOutcome;
          }

          yield* fs
            .remove(target, { recursive: true })
            .pipe(
              Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))),
            );

          return {
            success: true,
            message: `Successfully deleted ${abbreviateHomePath(target)}`,
          } satisfies WorkspaceMutationOutcome;
        }.bind(this),
      ),
    );

  readonly rename: WorkspaceService["rename"] = (agentId, oldVirtualPath, newVirtualPath) =>
    this.withValidatedAgentLock(
      agentId,
      Effect.gen(
        function* (this: WorkspaceServiceImpl) {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* this.ensureAgentRoot(agentId);
          const source = yield* resolveWorkspacePath(root, oldVirtualPath);
          const destination = yield* resolveWorkspacePath(root, newVirtualPath);

          if (source === root || destination === root) {
            return {
              success: false,
              message: "Error: cannot rename your workspace root",
            } satisfies WorkspaceMutationOutcome;
          }

          const sourceExists = yield* fs
            .exists(source)
            .pipe(Effect.catchAll(() => Effect.succeed(false)));
          if (!sourceExists) {
            return {
              success: false,
              message: `Error: The path ${abbreviateHomePath(source)} does not exist`,
            } satisfies WorkspaceMutationOutcome;
          }

          const destinationExists = yield* fs
            .exists(destination)
            .pipe(Effect.catchAll(() => Effect.succeed(false)));
          if (destinationExists) {
            return {
              success: false,
              message: `Error: The destination ${abbreviateHomePath(destination)} already exists`,
            } satisfies WorkspaceMutationOutcome;
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
          } satisfies WorkspaceMutationOutcome;
        }.bind(this),
      ),
    );
}

/**
 * Layer for `WorkspaceService`. Reads `workspaceMaxTotalBytesPerAgent` from
 * `AgentConfigService` so the total-size cap is user-configurable, unlike
 * `MemoryService`'s fixed constants — scratch-space needs vary far more.
 */
export function createWorkspaceServiceLayer(
  options?: Pick<WorkspaceServiceImplOptions, "baseWorkspaceDirectory">,
): Layer.Layer<WorkspaceService, never, AgentConfigService> {
  return Layer.effect(
    WorkspaceServiceTag,
    Effect.gen(function* () {
      const configService = yield* AgentConfigServiceTag;
      const appConfig = yield* configService.appConfig;
      const maxTotalBytesPerAgent =
        appConfig.workspaceMaxTotalBytesPerAgent ?? DEFAULT_MAX_WORKSPACE_TOTAL_BYTES_PER_AGENT;
      return new WorkspaceServiceImpl({ ...options, maxTotalBytesPerAgent });
    }),
  );
}
