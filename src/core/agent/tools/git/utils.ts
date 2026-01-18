import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { type FileSystemContextService, FileSystemContextServiceTag } from "../../../interfaces/fs";
import type { ToolExecutionContext } from "../../../types";
import { createSanitizedEnv } from "../../../utils/env-utils";
import { buildKeyFromContext } from "../context-utils";

/**
 * Git command execution utilities
 * Shared utilities for running Git commands safely
 */

export const DEFAULT_GIT_TIMEOUT = 15000;

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Execute a Git command with proper error handling and timeout
 */
export function runGitCommand(options: {
  readonly args: readonly string[];
  readonly workingDirectory: string;
  readonly timeoutMs?: number;
}): Effect.Effect<GitCommandResult, Error> {
  return Effect.gen(function* () {
    const { spawn } = yield* Effect.promise(() => import("child_process"));

    return yield* Effect.async<GitCommandResult, Error>((resume) => {
      const sanitizedEnv = createSanitizedEnv();
      const gitArgs = ["--no-pager", ...options.args];
      const child = spawn("git", gitArgs, {
        cwd: options.workingDirectory,
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizedEnv,
        detached: false,
      });

      let stdout = "";
      let stderr = "";

      const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT;
      const timeoutId = setTimeout(() => {
        child.kill("SIGTERM");
        resume(Effect.fail(new Error(`Git command timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("error", (error) => {
        clearTimeout(timeoutId);
        resume(Effect.fail(error));
      });

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        resume(
          Effect.succeed({
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            exitCode: code ?? 0,
          }),
        );
      });
    });
  });
}

/**
 * Resolves the working directory for git commands that can work with both files and directories.
 * If the path is a file, returns its parent directory.
 * If the path is a directory, returns it directly.
 * If the path doesn't exist, returns an error.
 */
export function resolveGitWorkingDirectory(
  shell: FileSystemContextService,
  context: ToolExecutionContext,
  fs: FileSystem.FileSystem,
  path?: string,
): Effect.Effect<string, Error, FileSystem.FileSystem | FileSystemContextService> {
  return Effect.gen(function* () {
    const key = buildKeyFromContext(context);
    let resolvedPath: string;

    if (path && path.trim().length > 0) {
      resolvedPath = yield* shell.resolvePath(key, path);
    } else {
      resolvedPath = yield* shell.getCwd(key);
    }

    // Check if the path exists (file or directory)
    const stat = yield* fs.stat(resolvedPath).pipe(Effect.catchAll(() => Effect.succeed(null)));

    if (stat === null) {
      return yield* Effect.fail(new Error(`Path does not exist: ${resolvedPath}`));
    }

    // If it's a directory, use it directly
    if (stat.type === "Directory") {
      return resolvedPath;
    }

    // If it's a file, get its parent directory
    if (stat.type === "File") {
      const pathModule = yield* Effect.promise(() => import("path"));
      const parentDir = pathModule.dirname(resolvedPath);
      return parentDir;
    }

    // For other types (symlinks, etc.), try to use the path as-is
    // Git commands will handle validation
    return resolvedPath;
  });
}

/**
 * Helper to build context key from tool execution context
 */
export { buildKeyFromContext } from "../context-utils";

/**
 * Re-export FileSystemContextServiceTag for convenience
 */
export { FileSystemContextServiceTag };
