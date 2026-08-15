/**
 * Shared Git execution helpers.
 *
 * Tool modules should resolve a repository directory once, then run git through
 * `runGitOrFail` so spawn errors and working-directory failures stay consistent
 * between approval and execution.
 */
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { createSanitizedEnv } from "@/core/utils/env";
import {
  bindCappedStdio,
  decodeCappedText,
  DEFAULT_SPAWN_OUTPUT_CAP_BYTES,
  spawnOutputTruncationNotice,
} from "../capped-output";
import { buildKeyFromContext } from "../context-utils";

export const GIT_TIMEOUTS = {
  default: 15_000,
  diff: 20_000,
  merge: 30_000,
} as const;

export const DEFAULT_GIT_TIMEOUT = GIT_TIMEOUTS.default;

export const gitRepoPathSchema = z
  .string()
  .optional()
  .describe("Repository path (defaults to cwd)");

export type GitToolDeps = FileSystem.FileSystem | FileSystemContextService;

export type GitResolvedDirectory = {
  readonly kind: "directory";
  readonly path: string;
};

export type GitCommandFailure = {
  readonly kind: "failure";
  readonly result: ToolExecutionResult;
};

export type GitCommandSuccess = {
  readonly kind: "ok";
  readonly result: GitCommandResult;
};

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
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

      const snapshot = bindCappedStdio(child.stdout, child.stderr, DEFAULT_SPAWN_OUTPUT_CAP_BYTES);

      const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT;
      const timeoutId = setTimeout(() => {
        child.kill("SIGTERM");
        resume(Effect.fail(new Error(`Git command timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      child.on("error", (error) => {
        clearTimeout(timeoutId);
        resume(Effect.fail(error));
      });

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        const collected = snapshot();
        const stdout = decodeCappedText(collected.stdout, {
          trim: "end",
          dropIncompleteLastLine: true,
        });
        const stderr = decodeCappedText(collected.stderr, {
          trim: "end",
          dropIncompleteLastLine: true,
        });
        resume(
          Effect.succeed({
            stdout: stdout.text,
            stderr: stderr.text,
            exitCode: code ?? 0,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
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
 * Resolve a git working directory into a tool-result failure instead of throwing.
 */
export function resolveGitRepoDir(
  path: string | undefined,
  context: ToolExecutionContext,
): Effect.Effect<GitResolvedDirectory | GitCommandFailure, never, GitToolDeps> {
  return Effect.gen(function* () {
    const shell = yield* FileSystemContextServiceTag;
    const fs = yield* FileSystem.FileSystem;
    const resolved = yield* resolveGitWorkingDirectory(shell, context, fs, path).pipe(
      Effect.either,
    );

    if (resolved._tag === "Left") {
      return {
        kind: "failure",
        result: {
          success: false,
          result: null,
          error:
            resolved.left instanceof Error
              ? resolved.left.message
              : String(resolved.left) || "Failed to resolve working directory",
        },
      };
    }

    return { kind: "directory", path: resolved.right };
  });
}

/**
 * Resolve the same git working directory used at execution time for approval copy.
 */
export function gitApprovalDirectory(
  path: string | undefined,
  context: ToolExecutionContext,
): Effect.Effect<string, Error, GitToolDeps> {
  return Effect.gen(function* () {
    const shell = yield* FileSystemContextServiceTag;
    const fs = yield* FileSystem.FileSystem;
    return yield* resolveGitWorkingDirectory(shell, context, fs, path);
  });
}

/**
 * Run a git command, mapping spawn failures (and optionally non-zero exits) to tool results.
 */
export function runGitOrFail(
  commandName: string,
  options: {
    readonly args: readonly string[];
    readonly workingDirectory: string;
    readonly timeoutMs?: number;
    readonly failOnNonZero?: boolean;
  },
): Effect.Effect<GitCommandSuccess | GitCommandFailure, never> {
  const failOnNonZero = options.failOnNonZero !== false;
  return runGitCommand({
    args: options.args,
    workingDirectory: options.workingDirectory,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  }).pipe(
    Effect.map((result): GitCommandSuccess | GitCommandFailure => {
      if (failOnNonZero && result.exitCode !== 0) {
        const stderr = result.stderrTruncated
          ? `${result.stderr}\n${spawnOutputTruncationNotice("stderr")}`
          : result.stderr;
        return {
          kind: "failure",
          result: {
            success: false,
            result: null,
            error: stderr || `${commandName} failed with exit code ${result.exitCode}`,
          },
        };
      }
      return { kind: "ok", result };
    }),
    Effect.catchAll((error) =>
      Effect.succeed({
        kind: "failure" as const,
        result: {
          success: false,
          result: null,
          error: `Failed to execute ${commandName} in directory '${options.workingDirectory}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      }),
    ),
  );
}

/**
 * Return HEAD's commit hash, or `"unknown"` when git cannot report it.
 */
export function getHeadCommitHash(workingDirectory: string): Effect.Effect<string, never> {
  return runGitCommand({
    args: ["rev-parse", "HEAD"],
    workingDirectory,
  }).pipe(
    Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "unknown")),
    Effect.catchAll(() => Effect.succeed("unknown")),
  );
}

export { buildKeyFromContext } from "../context-utils";
export { FileSystemContextServiceTag };

/**
 * Copy byte-cap truncation onto a git tool's model-facing result without
 * putting a marker into stdout that parsers split into fake paths/commits.
 */
export function withGitTruncation<T extends object>(
  payload: T,
  gitResult: GitCommandResult,
): T & { readonly truncated?: true } {
  if (!gitResult.stdoutTruncated && !gitResult.stderrTruncated) {
    return payload;
  }
  return { ...payload, truncated: true };
}
