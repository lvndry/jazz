import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "../../interfaces/fs";
import type { Tool } from "../../interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "../../types";
import { createSanitizedEnv } from "../../utils/env-utils";
import {
  defineTool,
  formatApprovalRequiredDescription,
  formatExecutionToolDescription,
} from "./base-tool";
import { buildKeyFromContext } from "./context-utils";

/**
 * Git command execution tools
 * Provides safe, structured access to common Git operations
 */

const DEFAULT_GIT_TIMEOUT = 15000;

interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function runGitCommand(options: {
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
function resolveGitWorkingDirectory(
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

// Safe Git operations (no approval needed) \\

export function createGitStatusTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
    })
    .strict();

  type GitStatusArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitStatusArgs>({
    name: "git_status",
    description:
      "Display the current status of a Git repository's working tree. Shows modified files, untracked files, staged changes, and current branch information. Use this to understand what changes exist before committing or to check repository state.",
    tags: ["git", "status"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (
      args: GitStatusArgs,
      context: ToolExecutionContext,
    ): Effect.Effect<
      ToolExecutionResult,
      Error,
      FileSystem.FileSystem | FileSystemContextService
    > =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

        // Catch spawn errors (e.g., git not found, invalid cwd)
        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: ["status", "--short", "--branch"],
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git status in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git status in directory '${workingDir}'`,
          };
        }

        const gitResult = commandResult;

        if (gitResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error: `git status failed in directory '${workingDir}' with exit code ${gitResult.exitCode}: ${gitResult.stderr || "Unknown error"}`,
          };
        }

        const lines = gitResult.stdout.split("\n").filter((line) => line.trim().length > 0);
        const branchLine = lines.find((line) => line.startsWith("##")) ?? "";
        const changes = lines.filter((line) => !line.startsWith("##"));
        const hasChanges = changes.length > 0;

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            branch: branchLine.replace(/^##\s*/, "") || "unknown",
            hasChanges,
            summary: hasChanges ? changes : ["Working tree clean"],
            rawStatus: gitResult.stdout,
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { hasChanges: boolean; branch?: string };
        const suffix = gitResult.branch ? ` on ${gitResult.branch}` : "";
        return gitResult.hasChanges
          ? `Repository has changes${suffix}`
          : `Repository is clean${suffix}`;
      }
      return result.success ? "Git status retrieved" : "Git status failed";
    },
  });
}

export function createGitLogTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Limit the number of commits to show"),
      oneline: z.boolean().optional().describe("Show commits in one-line format"),
    })
    .strict();

  type GitLogArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitLogArgs>({
    name: "git_log",
    description:
      "Display commit history of a Git repository. Shows commit hashes, authors, dates, and messages. Supports limiting results and one-line format for quick overview. Use to review recent changes, find specific commits, or understand repository evolution.",
    tags: ["git", "history"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitLogArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

        const limit = args?.limit ?? 10;
        const prettyFormat = "%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1e";

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: [
            "log",
            `--max-count=${limit}`,
            `--pretty=format:${prettyFormat}`,
            "--date=relative",
          ],
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git log in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        // If runGitCommand failed (spawn error), return the error
        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git log in directory '${workingDir}'`,
          };
        }

        const gitResult = commandResult;

        if (gitResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error: `git log failed in directory '${workingDir}' with exit code ${gitResult.exitCode}: ${gitResult.stderr || "Unknown error"}`,
          };
        }

        const commits = gitResult.stdout
          .split("\x1e")
          .filter((entry) => entry.trim().length > 0)
          .map((entry) => {
            const [hash, shortHash, author, relativeDate, subject] = entry
              .split("\x1f")
              .map((value) => value.trim());
            return {
              hash,
              shortHash,
              author,
              relativeDate,
              subject,
              oneline: args?.oneline ? `${shortHash} ${subject}` : undefined,
            };
          });

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            commitCount: commits.length,
            commits,
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { commitCount: number };
        return `Retrieved ${gitResult.commitCount} commits from Git history`;
      }
      return result.success ? "Git log retrieved" : "Git log failed";
    },
  });
}

export function createGitDiffTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      staged: z.boolean().optional().describe("Show staged changes (cached)"),
      branch: z.string().optional().describe("Compare with a specific branch"),
      commit: z.string().optional().describe("Compare with a specific commit"),
    })
    .strict();

  type GitDiffArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitDiffArgs>({
    name: "git_diff",
    description:
      "Display differences between commits, branches, or working tree. Shows what has changed in files (additions, deletions, modifications). Use to review changes before committing, compare branches, or see what differs from a specific commit. Supports staged changes and branch comparisons.",
    tags: ["git", "diff"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitDiffArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        // Catch errors from path resolution
        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

        const diffArgs: string[] = ["diff", "--no-color"];
        if (args?.staged) {
          diffArgs.push("--staged");
        }
        if (args?.branch) {
          diffArgs.push(args.branch);
        } else if (args?.commit) {
          diffArgs.push(args.commit);
        }

        // Catch spawn errors (e.g., git not found, invalid cwd)
        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: diffArgs,
          workingDirectory: workingDir,
          timeoutMs: 20000,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git diff in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        // If runGitCommand failed (spawn error), return the error
        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git diff in directory '${workingDir}'`,
          };
        }

        const gitResult = commandResult;

        if (gitResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error: `git diff failed in directory '${workingDir}' with exit code ${gitResult.exitCode}: ${gitResult.stderr || "Unknown error"}`,
          };
        }

        const trimmedDiff = gitResult.stdout.trimEnd();
        const hasChanges = trimmedDiff.length > 0;

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            diff: trimmedDiff || "No differences",
            hasChanges,
            options: {
              staged: args.staged ?? false,
              branch: args.branch,
              commit: args.commit,
            },
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { hasChanges: boolean };
        return gitResult.hasChanges ? "Repository has differences" : "No differences found";
      }
      return result.success ? "Git diff retrieved" : "Git diff failed";
    },
  });
}

export function createGitBranchTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe("Path to the Git repository (defaults to current working directory)"),
      list: z.boolean().optional().describe("List branches"),
      all: z.boolean().optional().describe("List both local and remote branches"),
      remote: z.boolean().optional().describe("List only remote branches"),
    })
    .strict();

  type GitBranchArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitBranchArgs>({
    name: "git_branch",
    description:
      "List Git branches (local, remote, or both). Shows all available branches and identifies the current branch. Use to see what branches exist, check which branch you're on, or discover remote branches. Note: This tool only lists branches; use git_checkout to switch branches.",
    tags: ["git", "branch"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitBranchArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;
        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

        const branchArgs: string[] = ["branch", "--list"];
        if (args?.remote) {
          branchArgs.push("--remotes");
        } else if (args?.all) {
          branchArgs.push("--all");
        }

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: branchArgs,
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git branch in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git branch in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error:
              commandResult.stderr || `git branch failed with exit code ${commandResult.exitCode}`,
          };
        }

        const lines = commandResult.stdout.split("\n").filter((line) => line.trim().length > 0);
        let currentBranch: string | undefined;
        const branches = lines.map((line) => {
          const trimmed = line.replace(/^\*\s*/, "").trim();
          if (line.trim().startsWith("*")) {
            currentBranch = trimmed;
          }
          return trimmed;
        });

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            branches,
            currentBranch,
            options: {
              list: args?.list !== false,
              all: args?.all ?? false,
              remote: args?.remote ?? false,
            },
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { branches: string[]; currentBranch?: string };
        return `Found ${gitResult.branches.length} branches${
          gitResult.currentBranch ? ` (current: ${gitResult.currentBranch})` : ""
        }`;
      }
      return result.success ? "Git branches retrieved" : "Git branch failed";
    },
  });
}

// Potentially destructive operations (approval required)

export function createGitAddTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      files: z.array(z.string()).min(1).describe("Files to add to the staging area"),
      all: z.boolean().optional().describe("Add all changes in the working directory"),
    })
    .strict();

  type GitAddArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitAddArgs>({
    name: "git_add",
    description: formatApprovalRequiredDescription(
      "Stage files for commit by adding them to Git's index. Prepares changes to be included in the next commit. Can stage specific files or all changes. This tool requests user approval and does NOT perform the staging directly. After the user confirms, you MUST call execute_git_add with the exact arguments provided in the approval response.",
    ),
    tags: ["git", "index"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: GitAddArgs, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const workingDir = args?.path
            ? yield* shell.resolvePath(
                {
                  agentId: context.agentId,
                  ...(context.conversationId && { conversationId: context.conversationId }),
                },
                args?.path,
              )
            : yield* shell.getCwd({
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              });

          const filesToAdd = args?.all ? "all files" : args?.files.join(", ");
          return `Add ${filesToAdd} to git staging in ${workingDir}?\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_git_add tool with these exact arguments: {"path": ${args?.path ? `"${args?.path}"` : "undefined"}, "files": ${JSON.stringify(args?.files)}, "all": ${args?.all === true}}`;
        }),
      errorMessage: "Approval required: git add requires user confirmation.",
      execute: {
        toolName: "execute_git_add",
        buildArgs: (args) => {
          return {
            path: args?.path,
            files: args?.files,
            all: args?.all,
          };
        },
      },
    },
    handler: (_args: Record<string, unknown>, _context: ToolExecutionContext) =>
      Effect.succeed({
        success: false,
        result: null,
        error: "Approval required",
      } as ToolExecutionResult),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { addedFiles: string | string[] };
        return `Added ${Array.isArray(gitResult.addedFiles) ? gitResult.addedFiles.join(", ") : gitResult.addedFiles} to staging area`;
      }
      return result.success ? "Files added to Git" : "Git add failed";
    },
  });
}

export function createExecuteGitAddTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      files: z.array(z.string()).min(1).describe("Files to add to the staging area"),
      all: z.boolean().optional().describe("Add all changes in the working directory"),
    })
    .strict();

  type GitAddArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitAddArgs>({
    name: "execute_git_add",
    description: formatExecutionToolDescription(
      "Performs the actual git add operation after user approval of git_add. Stages files for commit by adding them to Git's index. This tool should only be called after git_add receives user approval.",
    ),
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitAddArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

        const addArgs: string[] = ["add"];
        if (args?.all) {
          addArgs.push("--all");
        } else {
          addArgs.push(...args.files);
        }

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: addArgs,
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git add in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git add in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error:
              commandResult.stderr || `git add failed with exit code ${commandResult.exitCode}`,
          };
        }

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            addedFiles: args?.all ? "all files" : args?.files,
            message: "Files added to staging area",
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { addedFiles: string | string[] };
        return `Added ${Array.isArray(gitResult.addedFiles) ? gitResult.addedFiles.join(", ") : gitResult.addedFiles} to staging area`;
      }
      return result.success ? "Files added to Git" : "Git add failed";
    },
  });
}

export function createGitRmTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      files: z.array(z.string()).min(1).describe("Files to remove from Git tracking"),
      cached: z.boolean().optional().describe("Remove from index only (keep in working directory)"),
      recursive: z.boolean().optional().describe("Remove directories recursively"),
      force: z.boolean().optional().describe("Force removal (overrides safety checks)"),
    })
    .strict();

  type GitRmArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitRmArgs>({
    name: "git_rm",
    description: formatApprovalRequiredDescription(
      "Remove files from Git tracking and optionally from the working directory. Removes files from the index (staging area) and can also delete them from the filesystem. Supports removing from index only (cached), recursive directory removal, and force removal. This tool requests user approval and does NOT perform the removal directly. After the user confirms, you MUST call execute_git_rm with the exact arguments provided in the approval response.",
    ),
    tags: ["git", "remove"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: GitRmArgs, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const workingDir = args?.path
            ? yield* shell.resolvePath(
                {
                  agentId: context.agentId,
                  ...(context.conversationId && { conversationId: context.conversationId }),
                },
                args?.path,
              )
            : yield* shell.getCwd({
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              });

          const options = [];
          if (args?.cached) options.push("index only");
          if (args?.recursive) options.push("recursive");
          if (args?.force) options.push("force");
          const optionsStr = options.length > 0 ? ` (${options.join(", ")})` : "";
          const filesToRemove = args?.files.join(", ");
          return `Remove ${filesToRemove} from Git tracking${optionsStr} in ${workingDir}?\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_git_rm tool with these exact arguments: {"path": ${args?.path ? `"${args?.path}"` : "undefined"}, "files": ${JSON.stringify(args?.files)}, "cached": ${args?.cached === true}, "recursive": ${args?.recursive === true}, "force": ${args?.force === true}}`;
        }),
      errorMessage: "Approval required: git rm requires user confirmation.",
      execute: {
        toolName: "execute_git_rm",
        buildArgs: (args) => {
          return {
            path: args?.path,
            files: args?.files,
            cached: args?.cached,
            recursive: args?.recursive,
            force: args?.force,
          };
        },
      },
    },
    handler: (_args: Record<string, unknown>, _context: ToolExecutionContext) =>
      Effect.succeed({
        success: false,
        result: null,
        error: "Approval required",
      } as ToolExecutionResult),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { removedFiles: string | string[] };
        return `Removed ${Array.isArray(gitResult.removedFiles) ? gitResult.removedFiles.join(", ") : gitResult.removedFiles} from Git tracking`;
      }
      return result.success ? "Files removed from Git" : "Git rm failed";
    },
  });
}

export function createExecuteGitRmTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      files: z.array(z.string()).min(1).describe("Files to remove from Git tracking"),
      cached: z.boolean().optional().describe("Remove from index only (keep in working directory)"),
      recursive: z.boolean().optional().describe("Remove directories recursively"),
      force: z.boolean().optional().describe("Force removal (overrides safety checks)"),
    })
    .strict();

  type GitRmArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitRmArgs>({
    name: "execute_git_rm",
    description: formatExecutionToolDescription(
      "Performs the actual git rm operation after user approval of git_rm. Removes files from Git tracking and optionally from the working directory. This tool should only be called after git_rm receives user approval.",
    ),
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitRmArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

        const rmArgs: string[] = ["rm"];
        if (args?.cached) {
          rmArgs.push("--cached");
        }
        if (args?.recursive) {
          rmArgs.push("-r");
        }
        if (args?.force) {
          rmArgs.push("-f");
        }
        rmArgs.push(...args.files);

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: rmArgs,
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git rm in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git rm in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error: commandResult.stderr || `git rm failed with exit code ${commandResult.exitCode}`,
          };
        }

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            removedFiles: args?.files,
            cached: args?.cached || false,
            recursive: args?.recursive || false,
            force: args?.force || false,
            message: "Files removed from Git tracking",
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { removedFiles: string | string[] };
        return `Removed ${Array.isArray(gitResult.removedFiles) ? gitResult.removedFiles.join(", ") : gitResult.removedFiles} from Git tracking`;
      }
      return result.success ? "Files removed from Git" : "Git rm failed";
    },
  });
}

export function createGitCommitTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      message: z.string().min(1).describe("Commit message"),
      all: z.boolean().optional().describe("Commit all changes in the working directory"),
    })
    .strict();

  type GitCommitArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitCommitArgs>({
    name: "git_commit",
    description: formatApprovalRequiredDescription(
      "Create a commit to permanently record staged changes in the repository history. Requires a commit message describing the changes. Can commit all staged changes or all working directory changes. This tool requests user approval and does NOT perform the commit directly. After the user confirms, you MUST call execute_git_commit with the exact arguments provided in the approval response.",
    ),
    tags: ["git", "commit"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: GitCommitArgs, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const workingDir = args?.path
            ? yield* shell.resolvePath(
                {
                  agentId: context.agentId,
                  ...(context.conversationId && { conversationId: context.conversationId }),
                },
                args?.path,
              )
            : yield* shell.getCwd({
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              });

          return `Commit changes in ${workingDir} with message: "${args?.message}"?\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_git_commit tool with these exact arguments: {"path": ${args?.path ? `"${args?.path}"` : "undefined"}, "message": ${JSON.stringify(args?.message)}, "all": ${args?.all === true}}`;
        }),
      errorMessage: "Approval required: git commit requires user confirmation.",
      execute: {
        toolName: "execute_git_commit",
        buildArgs: (args) => {
          return {
            path: args?.path,
            message: args?.message,
            all: args?.all,
          };
        },
      },
    },
    handler: (_args: GitCommitArgs, _context: ToolExecutionContext) =>
      Effect.succeed({
        success: false,
        result: null,
        error: "Approval required",
      } as ToolExecutionResult),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { message: string; commitHash: string };
        return `Committed: "${gitResult.message}" (${gitResult.commitHash})`;
      }
      return result.success ? "Git commit created" : "Git commit failed";
    },
  });
}

export function createExecuteGitCommitTool(): Tool<
  FileSystem.FileSystem | FileSystemContextService
> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      message: z.string().min(1).describe("Commit message"),
      all: z.boolean().optional().describe("Commit all changes in the working directory"),
    })
    .strict();

  type GitCommitArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitCommitArgs>({
    name: "execute_git_commit",
    description: formatExecutionToolDescription(
      "Performs the actual git commit operation after user approval of git_commit. Creates a commit with the specified message. This tool should only be called after git_commit receives user approval.",
    ),
    hidden: true,
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitCommitArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

        const commitArgs: string[] = ["commit", "-m", args.message];
        if (args?.all) {
          commitArgs.push("--all");
        }

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: commitArgs,
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git commit in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git commit in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error:
              commandResult.stderr || `git commit failed with exit code ${commandResult.exitCode}`,
          };
        }

        // Get the commit hash from the last commit
        const hashResult = yield* runGitCommand({
          args: ["rev-parse", "HEAD"],
          workingDirectory: workingDir,
        }).pipe(Effect.catchAll(() => Effect.succeed(null)));

        const commitHash =
          hashResult === null || hashResult.exitCode !== 0 ? "unknown" : hashResult.stdout.trim();

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            message: args?.message,
            commitHash,
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { message: string; commitHash: string };
        return `Committed: "${gitResult.message}" (${gitResult.commitHash})`;
      }
      return result.success ? "Git commit created" : "Git commit failed";
    },
  });
}

export function createGitPushTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe("Path to the Git repository (defaults to current working directory)"),
      remote: z.string().optional().describe("Remote repository name (defaults to 'origin')"),
      branch: z.string().optional().describe("Branch to push (defaults to current branch)"),
      force: z.boolean().optional().describe("Force push (overwrites remote history)"),
    })
    .strict();

  type GitPushArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitPushArgs>({
    name: "git_push",
    description: formatApprovalRequiredDescription(
      "Upload local commits to a remote repository. Pushes the current branch (or specified branch) to the remote (default: origin). Supports force push to overwrite remote history (use with caution). This tool requests user approval and does NOT perform the push directly. After the user confirms, you MUST call execute_git_push with the exact arguments provided in the approval response.",
    ),
    tags: ["git", "push"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: GitPushArgs, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const workingDir = args?.path
            ? yield* shell.resolvePath(
                {
                  agentId: context.agentId,
                  ...(context.conversationId && { conversationId: context.conversationId }),
                },
                args?.path,
              )
            : yield* shell.getCwd({
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              });

          const remote = args?.remote || "origin";
          const branch = args?.branch || "current branch";
          const force = args?.force ? " (force push)" : "";
          return `Push${force} to ${remote}/${branch} in ${workingDir}?\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_git_push tool with these exact arguments: {"path": ${args?.path ? `"${args.path}"` : "undefined"}, "remote": ${args?.remote ? `"${args.remote}"` : "undefined"}, "branch": ${args?.branch ? `"${args.branch}"` : "undefined"}, "force": ${args?.force === true}}`;
        }),
      errorMessage: "Approval required: Git push requires user confirmation.",
      execute: {
        toolName: "execute_git_push",
        buildArgs: (args) => {
          return {
            path: args?.path,
            remote: args?.remote,
            branch: args?.branch,
            force: args?.force,
          };
        },
      },
    },
    handler: (_args: Record<string, unknown>, _context: ToolExecutionContext) =>
      Effect.succeed({
        success: false,
        result: null,
        error: "Approval required",
      } as ToolExecutionResult),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { remote: string; branch: string; force: boolean };
        return `Pushed to ${gitResult.remote}/${gitResult.branch}${gitResult.force ? " (force)" : ""}`;
      }
      return result.success ? "Git push successful" : "Git push failed";
    },
  });
}

export function createGitPullTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe("Path to the Git repository (defaults to current working directory)"),
      remote: z.string().optional().describe("Remote repository name (defaults to 'origin')"),
      branch: z.string().optional().describe("Branch to pull (defaults to current branch)"),
      rebase: z.boolean().optional().describe("Use rebase instead of merge"),
    })
    .strict();

  type GitPullArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitPullArgs>({
    name: "git_pull",
    description: formatApprovalRequiredDescription(
      "Download and merge changes from a remote repository into the current branch. Combines git fetch and git merge. Supports rebase mode to maintain linear history. Use to update your local branch with remote changes. This tool requests user approval and does NOT perform the pull directly. After the user confirms, you MUST call execute_git_pull with the exact arguments provided in the approval response.",
    ),
    tags: ["git", "pull"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: GitPullArgs, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const workingDir = args?.path
            ? yield* shell.resolvePath(
                {
                  agentId: context.agentId,
                  ...(context.conversationId && { conversationId: context.conversationId }),
                },
                args?.path,
              )
            : yield* shell.getCwd({
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              });

          const remote = args?.remote || "origin";
          const branch = args?.branch || "current branch";
          const rebase = args?.rebase ? " (with rebase)" : "";
          return `Pull${rebase} from ${remote}/${branch} in ${workingDir}?\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_git_pull tool with these exact arguments: {"path": ${args?.path ? `"${args.path}"` : "undefined"}, "remote": ${args?.remote ? `"${args.remote}"` : "undefined"}, "branch": ${args?.branch ? `"${args.branch}"` : "undefined"}, "rebase": ${args?.rebase === true}}`;
        }),
      errorMessage: "Approval required: Git pull requires user confirmation.",
      execute: {
        toolName: "execute_git_pull",
        buildArgs: (args) => {
          return {
            path: args?.path,
            remote: args?.remote,
            branch: args?.branch,
            rebase: args?.rebase,
          };
        },
      },
    },
    handler: (_args: GitPullArgs, _context: ToolExecutionContext) =>
      Effect.succeed({
        success: false,
        result: null,
        error: "Approval required",
      } as ToolExecutionResult),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { remote: string; branch: string; rebase: boolean };
        return `Pulled from ${gitResult.remote}/${gitResult.branch}${gitResult.rebase ? " (rebase)" : ""}`;
      }
      return result.success ? "Git pull successful" : "Git pull failed";
    },
  });
}

export function createGitCheckoutTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe("Path to the Git repository (defaults to current working directory)"),
      branch: z.string().min(1).describe("Branch name to checkout"),
      create: z.boolean().optional().describe("Create the branch if it doesn't exist"),
      force: z.boolean().optional().describe("Force checkout (discards local changes)"),
    })
    .strict();

  type GitCheckoutArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitCheckoutArgs>({
    name: "git_checkout",
    description: formatApprovalRequiredDescription(
      "Switch to a different branch or create a new branch. Changes the working directory to match the specified branch. Can create new branches or force checkout (discarding local changes). Use to navigate between branches or start work on a new feature branch. This tool requests user approval and does NOT perform the checkout directly. After the user confirms, you MUST call execute_git_checkout with the exact arguments provided in the approval response.",
    ),
    tags: ["git", "checkout"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: GitCheckoutArgs, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const workingDir = args?.path
            ? yield* shell.resolvePath(
                {
                  agentId: context.agentId,
                  ...(context.conversationId && { conversationId: context.conversationId }),
                },
                args?.path,
              )
            : yield* shell.getCwd({
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              });

          const create = args?.create ? " (create new branch)" : "";
          const force = args?.force ? " (force - discards changes)" : "";
          return `Checkout branch "${args?.branch}"${create}${force} in ${workingDir}?\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_git_checkout tool with these exact arguments: {"path": ${args?.path ? `"${args.path}"` : "undefined"}, "branch": "${args.branch}", "create": ${args?.create === true}, "force": ${args?.force === true}}`;
        }),
      errorMessage: "Approval required: Git checkout requires user confirmation.",
      execute: {
        toolName: "execute_git_checkout",
        buildArgs: (args) => {
          return {
            path: args?.path,
            branch: args?.branch,
            create: args?.create,
            force: args?.force,
          };
        },
      },
    },
    handler: (_args: GitCheckoutArgs, _context: ToolExecutionContext) =>
      Effect.succeed({
        success: false,
        result: null,
        error: "Approval required",
      } as ToolExecutionResult),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { branch: string; created: boolean };
        return `Switched to ${gitResult.branch}${gitResult.created ? " (newly created)" : ""}`;
      }
      return result.success ? "Git checkout successful" : "Git checkout failed";
    },
  });
}

export function createExecuteGitPushTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe("Path to the Git repository (defaults to current working directory)"),
      remote: z.string().optional().describe("Remote repository name (defaults to 'origin')"),
      branch: z.string().optional().describe("Branch to push (defaults to current branch)"),
      force: z.boolean().optional().describe("Force push (overwrites remote history)"),
    })
    .strict();

  type GitPushArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitPushArgs>({
    name: "execute_git_push",
    description: formatExecutionToolDescription(
      "Performs the actual git push operation after user approval of git_push. Uploads local commits to the remote repository. This tool should only be called after git_push receives user approval.",
    ),
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitPushArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

        const remote = args?.remote || "origin";
        const branch = args?.branch || "";

        const pushArgs: string[] = ["push"];
        if (args?.force) {
          pushArgs.push("--force");
        }
        if (branch) {
          pushArgs.push(remote, branch);
        } else {
          pushArgs.push(remote);
        }

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: pushArgs,
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git push in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git push in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error:
              commandResult.stderr || `git push failed with exit code ${commandResult.exitCode}`,
          };
        }

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            remote,
            branch: branch || "current",
            force: args?.force || false,
            message: "Changes pushed successfully",
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { remote: string; branch: string; force: boolean };
        return `Pushed to ${gitResult.remote}/${gitResult.branch}${gitResult.force ? " (force)" : ""}`;
      }
      return result.success ? "Git push successful" : "Git push failed";
    },
  });
}

export function createExecuteGitPullTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe("Path to the Git repository (defaults to current working directory)"),
      remote: z.string().optional().describe("Remote repository name (defaults to 'origin')"),
      branch: z.string().optional().describe("Branch to pull (defaults to current branch)"),
      rebase: z.boolean().optional().describe("Use rebase instead of merge"),
    })
    .strict();

  type GitPullArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitPullArgs>({
    name: "execute_git_pull",
    description: formatExecutionToolDescription(
      "Performs the actual git pull operation after user approval of git_pull. Downloads and merges changes from the remote repository. This tool should only be called after git_pull receives user approval.",
    ),
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitPullArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

        const remote = args?.remote || "origin";
        const branch = args?.branch || "";

        const pullArgs: string[] = ["pull"];
        if (args?.rebase) {
          pullArgs.push("--rebase");
        }
        if (branch) {
          pullArgs.push(remote, branch);
        } else {
          pullArgs.push(remote);
        }

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: pullArgs,
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git pull in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git pull in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error:
              commandResult.stderr || `git pull failed with exit code ${commandResult.exitCode}`,
          };
        }

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            remote,
            branch: branch || "current",
            rebase: args?.rebase || false,
            message: "Changes pulled successfully",
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { remote: string; branch: string; rebase: boolean };
        return `Pulled from ${gitResult.remote}/${gitResult.branch}${gitResult.rebase ? " (rebase)" : ""}`;
      }
      return result.success ? "Git pull successful" : "Git pull failed";
    },
  });
}

export function createExecuteGitCheckoutTool(): Tool<
  FileSystem.FileSystem | FileSystemContextService
> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe("Path to the Git repository (defaults to current working directory)"),
      branch: z.string().min(1).describe("Branch name to checkout"),
      create: z.boolean().optional().describe("Create the branch if it doesn't exist"),
      force: z.boolean().optional().describe("Force checkout (discards local changes)"),
    })
    .strict();

  type GitCheckoutArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitCheckoutArgs>({
    name: "execute_git_checkout",
    description: formatExecutionToolDescription(
      "Performs the actual git checkout operation after user approval of git_checkout. Switches to the specified branch or creates a new branch. This tool should only be called after git_checkout receives user approval.",
    ),
    hidden: true,
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitCheckoutArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

        const checkoutArgs: string[] = ["checkout"];
        if (args.create) {
          checkoutArgs.push("-b");
        }
        if (args.force) {
          checkoutArgs.push("--force");
        }
        checkoutArgs.push(args.branch);

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: checkoutArgs,
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git checkout in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git checkout in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error:
              commandResult.stderr ||
              `git checkout failed with exit code ${commandResult.exitCode}`,
          };
        }

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            branch: args.branch,
            created: args.create || false,
            force: args.force || false,
            message: `Switched to branch: ${args.branch}`,
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { branch: string; created: boolean };
        return `Switched to ${gitResult.branch}${gitResult.created ? " (newly created)" : ""}`;
      }
      return result.success ? "Git checkout successful" : "Git checkout failed";
    },
  });
}

export function createGitTagTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe("Path to the Git repository (defaults to current working directory)"),
      list: z.boolean().optional().describe("List all tags"),
      create: z.string().optional().describe("Create a new tag with the specified name"),
      message: z
        .string()
        .optional()
        .describe("Annotated tag message (required if creating an annotated tag)"),
      commit: z.string().optional().describe("Create tag at specific commit (defaults to HEAD)"),
      delete: z.string().optional().describe("Delete a tag with the specified name"),
      force: z
        .boolean()
        .optional()
        .describe("Force tag creation/deletion (overwrites existing tags)"),
    })
    .strict();

  type GitTagArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitTagArgs>({
    name: "git_tag",
    description:
      "List, create, or delete Git tags. Tags are references to specific points in Git history, commonly used to mark release points. Listing tags requires no approval. ⚠️ APPROVAL REQUIRED for creating or deleting tags: This tool requests user approval and does NOT perform the tag operation directly. After the user confirms, you MUST call execute_git_tag with the exact arguments provided in the approval response.",
    tags: ["git", "tag"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: GitTagArgs, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const workingDir = args?.path
            ? yield* shell.resolvePath(
                {
                  agentId: context.agentId,
                  ...(context.conversationId && { conversationId: context.conversationId }),
                },
                args?.path,
              )
            : yield* shell.getCwd({
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              });

          // If only listing, no approval needed - proceed with listing
          if (!args?.create && !args?.delete) {
            return `Listing tags in ${workingDir} - no approval needed. Proceeding with listing.`;
          }

          if (args?.create) {
            const tagType = args?.message ? "annotated" : "lightweight";
            const commit = args?.commit ? ` at commit ${args.commit}` : "";
            const force = args?.force ? " (force - overwrites existing)" : "";
            return `Create ${tagType} tag "${args.create}"${commit}${force} in ${workingDir}?\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_git_tag tool with these exact arguments: {"path": ${args?.path ? `"${args.path}"` : "undefined"}, "create": "${args.create}", "message": ${args?.message ? JSON.stringify(args.message) : "undefined"}, "commit": ${args?.commit ? `"${args.commit}"` : "undefined"}, "force": ${args?.force === true}}`;
          }

          if (args?.delete) {
            const force = args?.force ? " (force)" : "";
            return `Delete tag "${args.delete}"${force} in ${workingDir}?\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_git_tag tool with these exact arguments: {"path": ${args?.path ? `"${args.path}"` : "undefined"}, "delete": "${args.delete}", "force": ${args?.force === true}}`;
          }

          return "";
        }),
      errorMessage: "Approval required: git tag create/delete requires user confirmation.",
      execute: {
        toolName: "execute_git_tag",
        buildArgs: (args) => {
          return {
            path: args?.path,
            create: args?.create,
            message: args?.message,
            commit: args?.commit,
            delete: args?.delete,
            force: args?.force,
          };
        },
      },
    },
    handler: (args: GitTagArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        // If create or delete is specified, require approval (handled by approval mechanism)
        if (args?.create || args?.delete) {
          return {
            success: false,
            result: null,
            error: "Approval required",
          } as ToolExecutionResult;
        }

        // List tags (safe operation, no approval needed)
        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: ["tag", "--list", "--sort=-creatordate"],
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git tag in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git tag in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error:
              commandResult.stderr || `git tag failed with exit code ${commandResult.exitCode}`,
          };
        }

        const tags = commandResult.stdout
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((tag) => tag.trim());

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            tags,
            tagCount: tags.length,
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { tagCount?: number; tag?: string; deleted?: boolean };
        if (gitResult.deleted) {
          return `Deleted tag: ${gitResult.tag}`;
        }
        if (gitResult.tag) {
          return `Created tag: ${gitResult.tag}`;
        }
        if (gitResult.tagCount !== undefined) {
          return `Found ${gitResult.tagCount} tags`;
        }
      }
      return result.success ? "Git tag operation successful" : "Git tag operation failed";
    },
  });
}

export function createExecuteGitTagTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe("Path to the Git repository (defaults to current working directory)"),
      create: z.string().optional().describe("Create a new tag with the specified name"),
      message: z
        .string()
        .optional()
        .describe("Annotated tag message (required if creating an annotated tag)"),
      commit: z.string().optional().describe("Create tag at specific commit (defaults to HEAD)"),
      delete: z.string().optional().describe("Delete a tag with the specified name"),
      force: z
        .boolean()
        .optional()
        .describe("Force tag creation/deletion (overwrites existing tags)"),
    })
    .strict();

  type GitTagArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitTagArgs>({
    name: "execute_git_tag",
    description: formatExecutionToolDescription(
      "Performs the actual git tag operation after user approval of git_tag. Creates, deletes, or lists tags in the repository. This tool should only be called after git_tag receives user approval for create/delete operations.",
    ),
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitTagArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

        if (args?.create) {
          // Create tag
          const tagArgs: string[] = ["tag"];
          if (args?.force) {
            tagArgs.push("--force");
          }
          if (args?.message) {
            tagArgs.push("-a", args.create, "-m", args.message);
          } else {
            tagArgs.push(args.create);
          }
          if (args?.commit) {
            tagArgs.push(args.commit);
          }

          let commandError: string | null = null;
          const commandResult = yield* runGitCommand({
            args: tagArgs,
            workingDirectory: workingDir,
          }).pipe(
            Effect.catchAll((error) => {
              const errorMsg = error instanceof Error ? error.message : String(error);
              commandError = `Failed to execute git tag in directory '${workingDir}': ${errorMsg}`;
              return Effect.succeed(null);
            }),
          );

          if (commandResult === null) {
            return {
              success: false,
              result: null,
              error: commandError || `Failed to execute git tag in directory '${workingDir}'`,
            };
          }

          if (commandResult.exitCode !== 0) {
            return {
              success: false,
              result: null,
              error:
                commandResult.stderr || `git tag failed with exit code ${commandResult.exitCode}`,
            };
          }

          return {
            success: true,
            result: {
              workingDirectory: workingDir,
              tag: args.create,
              message: args?.message,
              commit: args?.commit || "HEAD",
              force: args?.force || false,
              created: true,
            },
          };
        }

        if (args?.delete) {
          // Delete tag
          const tagArgs: string[] = ["tag", "--delete"];
          if (args?.force) {
            tagArgs.push("--force");
          }
          tagArgs.push(args.delete);

          let commandError: string | null = null;
          const commandResult = yield* runGitCommand({
            args: tagArgs,
            workingDirectory: workingDir,
          }).pipe(
            Effect.catchAll((error) => {
              const errorMsg = error instanceof Error ? error.message : String(error);
              commandError = `Failed to execute git tag delete in directory '${workingDir}': ${errorMsg}`;
              return Effect.succeed(null);
            }),
          );

          if (commandResult === null) {
            return {
              success: false,
              result: null,
              error:
                commandError || `Failed to execute git tag delete in directory '${workingDir}'`,
            };
          }

          if (commandResult.exitCode !== 0) {
            return {
              success: false,
              result: null,
              error:
                commandResult.stderr ||
                `git tag delete failed with exit code ${commandResult.exitCode}`,
            };
          }

          return {
            success: true,
            result: {
              workingDirectory: workingDir,
              tag: args.delete,
              deleted: true,
              force: args?.force || false,
            },
          };
        }

        // List tags (when neither create nor delete is specified)
        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: ["tag", "--list", "--sort=-creatordate"],
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git tag list in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git tag list in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error:
              commandResult.stderr ||
              `git tag list failed with exit code ${commandResult.exitCode}`,
          };
        }

        const tags = commandResult.stdout
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((tag) => tag.trim());

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            tags,
            tagCount: tags.length,
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { tag: string; deleted?: boolean; created?: boolean };
        if (gitResult.deleted) {
          return `Deleted tag: ${gitResult.tag}`;
        }
        if (gitResult.created) {
          return `Created tag: ${gitResult.tag}`;
        }
      }
      return result.success ? "Git tag operation successful" : "Git tag operation failed";
    },
  });
}

export function createGitBlameTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      file: z.string().min(1).describe("Path to the file to blame (relative to repository root)"),
      startLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Start line number (1-based, inclusive)"),
      endLine: z.number().int().min(1).optional().describe("End line number (1-based, inclusive)"),
      showEmail: z.boolean().optional().describe("Show author email instead of name"),
      showLineNumbers: z.boolean().optional().describe("Show line numbers in output"),
    })
    .strict();

  type GitBlameArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitBlameArgs>({
    name: "git_blame",
    description:
      "Show what revision and author last modified each line of a file. Displays commit hash, author, date, and line content for each line. Useful for tracking who changed what and when, debugging issues, or understanding code history. Supports line range filtering and various output formats.",
    tags: ["git", "blame", "history"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitBlameArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

        const blameArgs: string[] = ["blame", "--no-color"];
        if (args?.showEmail) {
          blameArgs.push("--show-email");
        }
        if (args?.showLineNumbers) {
          blameArgs.push("--show-number");
        }

        // Add line range if specified
        if (args?.startLine && args?.endLine) {
          if (args.startLine > args.endLine) {
            return {
              success: false,
              result: null,
              error: `Invalid line range: start line (${args.startLine}) must be <= end line (${args.endLine})`,
            };
          }
          blameArgs.push(`-L${args.startLine},${args.endLine}`);
        } else if (args?.startLine) {
          blameArgs.push(`-L${args.startLine},${args.startLine}`);
        }

        blameArgs.push(args.file);

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: blameArgs,
          workingDirectory: workingDir,
          timeoutMs: 20000,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git blame in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git blame in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error:
              commandResult.stderr || `git blame failed with exit code ${commandResult.exitCode}`,
          };
        }

        const lines = commandResult.stdout
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            // Parse blame output format: commit_hash (author date line_number) content
            const match = line.match(/^(\S+)\s+\(([^)]+)\s+(\d+)\)\s+(.*)$/);
            if (match && match.length >= 5) {
              const hash = match[1] || "unknown";
              const authorInfo = match[2] || "unknown";
              const lineNum = match[3] || "0";
              const content = match[4] || line;
              return {
                commitHash: hash,
                author: authorInfo.trim(),
                lineNumber: parseInt(lineNum, 10),
                content,
              };
            }
            // Fallback if parsing fails
            return {
              commitHash: "unknown",
              author: "unknown",
              lineNumber: 0,
              content: line,
            };
          });

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            file: args.file,
            lineCount: lines.length,
            lines,
            options: {
              startLine: args?.startLine,
              endLine: args?.endLine,
              showEmail: args?.showEmail ?? false,
              showLineNumbers: args?.showLineNumbers ?? false,
            },
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { file: string; lineCount: number };
        return `Blamed ${gitResult.lineCount} lines in ${gitResult.file}`;
      }
      return result.success ? "Git blame retrieved" : "Git blame failed";
    },
  });
}

export function createGitMergeTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe("Path to the Git repository (defaults to current working directory)"),
      branch: z.string().min(1).describe("Branch or commit to merge into the current branch"),
      message: z.string().optional().describe("Merge commit message"),
      noFastForward: z
        .boolean()
        .optional()
        .describe("Create a merge commit even if fast-forward is possible"),
      squash: z
        .boolean()
        .optional()
        .describe("Squash all commits from the branch into a single commit"),
      abort: z.boolean().optional().describe("Abort an in-progress merge"),
      strategy: z
        .enum(["resolve", "recursive", "octopus", "ours", "subtree"])
        .optional()
        .describe("Merge strategy to use"),
    })
    .strict();

  type GitMergeArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitMergeArgs>({
    name: "git_merge",
    description: formatApprovalRequiredDescription(
      "Merge changes from another branch or commit into the current branch. Combines the history of two branches, creating a merge commit. Supports various merge strategies, squash merging, and fast-forward control. Can also abort an in-progress merge. This tool requests user approval and does NOT perform the merge directly. After the user confirms, you MUST call execute_git_merge with the exact arguments provided in the approval response.",
    ),
    tags: ["git", "merge"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: GitMergeArgs, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const workingDir = args?.path
            ? yield* shell.resolvePath(
                {
                  agentId: context.agentId,
                  ...(context.conversationId && { conversationId: context.conversationId }),
                },
                args?.path,
              )
            : yield* shell.getCwd({
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              });

          if (args?.abort) {
            return `Abort in-progress merge in ${workingDir}?\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_git_merge tool with these exact arguments: {"path": ${args?.path ? `"${args.path}"` : "undefined"}, "abort": true}`;
          }

          const options = [];
          if (args?.noFastForward) options.push("no fast-forward");
          if (args?.squash) options.push("squash");
          if (args?.strategy) options.push(`strategy: ${args.strategy}`);
          const optionsStr = options.length > 0 ? ` (${options.join(", ")})` : "";
          const messageStr = args?.message ? ` with message: "${args.message}"` : "";

          return `Merge branch "${args.branch}" into current branch${optionsStr}${messageStr} in ${workingDir}?\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_git_merge tool with these exact arguments: {"path": ${args?.path ? `"${args.path}"` : "undefined"}, "branch": "${args.branch}", "message": ${args?.message ? JSON.stringify(args.message) : "undefined"}, "noFastForward": ${args?.noFastForward === true}, "squash": ${args?.squash === true}, "strategy": ${args?.strategy ? `"${args.strategy}"` : "undefined"}}`;
        }),
      errorMessage: "Approval required: git merge requires user confirmation.",
      execute: {
        toolName: "execute_git_merge",
        buildArgs: (args) => {
          return {
            path: args?.path,
            branch: args?.branch,
            message: args?.message,
            noFastForward: args?.noFastForward,
            squash: args?.squash,
            abort: args?.abort,
            strategy: args?.strategy,
          };
        },
      },
    },
    handler: (_args: GitMergeArgs, _context: ToolExecutionContext) =>
      Effect.succeed({
        success: false,
        result: null,
        error: "Approval required",
      } as ToolExecutionResult),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { branch?: string; aborted?: boolean; merged?: boolean };
        if (gitResult.aborted) {
          return "Merge aborted";
        }
        if (gitResult.merged) {
          return `Merged ${gitResult.branch || "branch"} into current branch`;
        }
      }
      return result.success ? "Git merge successful" : "Git merge failed";
    },
  });
}

export function createExecuteGitMergeTool(): Tool<
  FileSystem.FileSystem | FileSystemContextService
> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe("Path to the Git repository (defaults to current working directory)"),
      branch: z.string().optional().describe("Branch or commit to merge into the current branch"),
      message: z.string().optional().describe("Merge commit message"),
      noFastForward: z
        .boolean()
        .optional()
        .describe("Create a merge commit even if fast-forward is possible"),
      squash: z
        .boolean()
        .optional()
        .describe("Squash all commits from the branch into a single commit"),
      abort: z.boolean().optional().describe("Abort an in-progress merge"),
      strategy: z
        .enum(["resolve", "recursive", "octopus", "ours", "subtree"])
        .optional()
        .describe("Merge strategy to use"),
    })
    .strict();

  type GitMergeArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitMergeArgs>({
    name: "execute_git_merge",
    description: formatExecutionToolDescription(
      "Performs the actual git merge operation after user approval of git_merge. Merges changes from another branch or commit into the current branch. This tool should only be called after git_merge receives user approval.",
    ),
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitMergeArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

        if (args?.abort) {
          // Abort merge
          const mergeArgs: string[] = ["merge", "--abort"];

          let commandError: string | null = null;
          const commandResult = yield* runGitCommand({
            args: mergeArgs,
            workingDirectory: workingDir,
          }).pipe(
            Effect.catchAll((error) => {
              const errorMsg = error instanceof Error ? error.message : String(error);
              commandError = `Failed to execute git merge --abort in directory '${workingDir}': ${errorMsg}`;
              return Effect.succeed(null);
            }),
          );

          if (commandResult === null) {
            return {
              success: false,
              result: null,
              error:
                commandError || `Failed to execute git merge --abort in directory '${workingDir}'`,
            };
          }

          if (commandResult.exitCode !== 0) {
            return {
              success: false,
              result: null,
              error:
                commandResult.stderr ||
                `git merge --abort failed with exit code ${commandResult.exitCode}`,
            };
          }

          return {
            success: true,
            result: {
              workingDirectory: workingDir,
              aborted: true,
              message: "Merge aborted successfully",
            },
          };
        }

        if (!args?.branch) {
          return {
            success: false,
            result: null,
            error: "Branch or commit must be specified for merge operation",
          };
        }

        // Perform merge
        const mergeArgs: string[] = ["merge"];
        if (args?.noFastForward) {
          mergeArgs.push("--no-ff");
        }
        if (args?.squash) {
          mergeArgs.push("--squash");
        }
        if (args?.strategy) {
          mergeArgs.push("--strategy", args.strategy);
        }
        if (args?.message) {
          mergeArgs.push("-m", args.message);
        }
        mergeArgs.push(args.branch);

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: mergeArgs,
          workingDirectory: workingDir,
          timeoutMs: 30000,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git merge in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git merge in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          // Merge conflicts or other errors
          const hasConflicts =
            commandResult.stderr.includes("conflict") || commandResult.stderr.includes("CONFLICT");
          return {
            success: false,
            result: {
              workingDirectory: workingDir,
              branch: args.branch,
              hasConflicts,
              error:
                commandResult.stderr || `git merge failed with exit code ${commandResult.exitCode}`,
            },
            error: hasConflicts
              ? "Merge conflicts detected. Please resolve conflicts before continuing."
              : commandResult.stderr || `git merge failed with exit code ${commandResult.exitCode}`,
          };
        }

        // Get the merge commit hash if available
        const hashResult = yield* runGitCommand({
          args: ["rev-parse", "HEAD"],
          workingDirectory: workingDir,
        }).pipe(Effect.catchAll(() => Effect.succeed(null)));

        const mergeCommitHash =
          hashResult === null || hashResult.exitCode !== 0 ? "unknown" : hashResult.stdout.trim();

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            branch: args.branch,
            merged: true,
            mergeCommitHash,
            message: args?.message,
            strategy: args?.strategy,
            noFastForward: args?.noFastForward || false,
            squash: args?.squash || false,
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { branch?: string; aborted?: boolean; merged?: boolean };
        if (gitResult.aborted) {
          return "Merge aborted";
        }
        if (gitResult.merged) {
          return `Merged ${gitResult.branch || "branch"} into current branch`;
        }
      }
      return result.success ? "Git merge successful" : "Git merge failed";
    },
  });
}

export function createGitReflogTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Limit the number of reflog entries to show"),
      branch: z
        .string()
        .optional()
        .describe("Show reflog for a specific branch (defaults to HEAD)"),
      all: z.boolean().optional().describe("Show reflog for all branches"),
      oneline: z.boolean().optional().describe("Show entries in one-line format"),
    })
    .strict();

  type GitReflogArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitReflogArgs>({
    name: "git_reflog",
    description:
      "Display the reference log showing where HEAD and branch references have been. Shows commit hashes, actions (checkout, commit, merge, etc.), and timestamps. Useful for recovering lost commits, understanding branch history, or tracking reference movements. Supports filtering by branch and limiting results.",
    tags: ["git", "reflog", "history"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitReflogArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

        const limit = args?.limit ?? 20;
        const reflogArgs: string[] = ["reflog", "--no-color"];

        if (args?.all) {
          reflogArgs.push("--all");
        } else if (args?.branch) {
          reflogArgs.push(args.branch);
        }

        if (limit > 0) {
          reflogArgs.push(`-n${limit}`);
        }

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: reflogArgs,
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git reflog in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git reflog in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error:
              commandResult.stderr || `git reflog failed with exit code ${commandResult.exitCode}`,
          };
        }

        // Parse reflog output format: <commit-hash> HEAD@{n}: <action>: <summary>
        // Example: abc1234 HEAD@{0}: checkout: moving from main to feature
        const entries = commandResult.stdout
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            // Match: <hash> <ref>@{<n>}: <action>: <summary>
            const match = line.match(/^(\S+)\s+(\S+@\{\d+\}):\s+(.+?)(?::\s+(.+))?$/);
            if (match && match.length >= 4) {
              const hash = match[1] || "unknown";
              const ref = match[2] || "unknown";
              const action = match[3] || "unknown";
              const summary = match[4] || "";

              // Extract short hash (first 7 characters)
              const shortHash = hash.length >= 7 ? hash.substring(0, 7) : hash;

              return {
                hash,
                shortHash,
                ref,
                action: action.trim(),
                summary: summary.trim(),
                oneline: args?.oneline
                  ? `${shortHash} ${ref}: ${action}${summary ? `: ${summary}` : ""}`
                  : undefined,
              };
            }
            // Fallback if parsing fails
            return {
              hash: "unknown",
              shortHash: "unknown",
              ref: "unknown",
              action: "unknown",
              summary: line,
              oneline: args?.oneline ? line : undefined,
            };
          });

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            entryCount: entries.length,
            entries,
            options: {
              limit,
              branch: args?.branch,
              all: args?.all ?? false,
              oneline: args?.oneline ?? false,
            },
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { entryCount: number };
        return `Retrieved ${gitResult.entryCount} reflog entries`;
      }
      return result.success ? "Git reflog retrieved" : "Git reflog failed";
    },
  });
}
