import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "../../interfaces/fs";
import type { Tool } from "../../interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "../../types";
import { createSanitizedEnv } from "../../utils/env-utils";
import { defineTool } from "./base-tool";
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

function resolveWorkingDirectory(
  shell: FileSystemContextService,
  context: ToolExecutionContext,
  path?: string,
): Effect.Effect<string, Error, FileSystem.FileSystem | FileSystemContextService> {
  const key = buildKeyFromContext(context);
  if (path && path.trim().length > 0) {
    return shell.resolvePath(key, path);
  }

  return shell.getCwd(key);
}

// Safe Git operations (no approval needed) \\

export function createGitStatusTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe("Path to the Git repository (defaults to current working directory)"),
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
        const workingDir = yield* resolveWorkingDirectory(shell, context, args?.path).pipe(
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

        let dirStatError: string | null = null;
        const dirStat = yield* fs.stat(workingDir).pipe(
          Effect.catchAll((error) => {
            dirStatError = `Working directory does not exist or is not accessible: ${workingDir}. ${error instanceof Error ? error.message : String(error)}`;
            return Effect.succeed(null);
          }),
        );

        if (dirStat === null) {
          return {
            success: false,
            result: null,
            error: dirStatError || `Working directory does not exist: ${workingDir}`,
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
        .describe("Path to the Git repository (defaults to current working directory)"),
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
        const workingDir = yield* resolveWorkingDirectory(shell, context, args?.path).pipe(
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

        let dirStatError: string | null = null;
        const dirStat = yield* fs.stat(workingDir).pipe(
          Effect.catchAll((error) => {
            dirStatError = `Working directory does not exist or is not accessible: ${workingDir}. ${error instanceof Error ? error.message : String(error)}`;
            return Effect.succeed(null);
          }),
        );

        if (dirStat === null) {
          return {
            success: false,
            result: null,
            error: dirStatError || `Working directory does not exist: ${workingDir}`,
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
        .describe("Path to the Git repository (defaults to current working directory)"),
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
        const workingDir = yield* resolveWorkingDirectory(shell, context, args?.path).pipe(
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

        let dirStatError: string | null = null;
        const dirStat = yield* fs.stat(workingDir).pipe(
          Effect.catchAll((error) => {
            dirStatError = `Working directory does not exist or is not accessible: ${workingDir}. ${error instanceof Error ? error.message : String(error)}`;
            return Effect.succeed(null);
          }),
        );

        if (dirStat === null) {
          return {
            success: false,
            result: null,
            error: dirStatError || `Working directory does not exist: ${workingDir}`,
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
        let workingDirError: string | null = null;
        const workingDir = yield* resolveWorkingDirectory(shell, context, args?.path).pipe(
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
        .describe("Path to the Git repository (defaults to current working directory)"),
      files: z.array(z.string()).min(1).describe("Files to add to the staging area"),
      all: z.boolean().optional().describe("Add all changes in the working directory"),
    })
    .strict();

  type GitAddArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitAddArgs>({
    name: "git_add",
    description:
      "Stage files for commit by adding them to Git's index. Prepares changes to be included in the next commit. Can stage specific files or all changes. Requires user approval before execution.",
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
        .describe("Path to the Git repository (defaults to current working directory)"),
      files: z.array(z.string()).min(1).describe("Files to add to the staging area"),
      all: z.boolean().optional().describe("Add all changes in the working directory"),
    })
    .strict();

  type GitAddArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitAddArgs>({
    name: "execute_git_add",
    description:
      "Internal tool that performs the actual git add operation after user has approved the git_add request. Stages files for commit by adding them to Git's index.",
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

        let workingDirError: string | null = null;
        const workingDir = yield* resolveWorkingDirectory(shell, context, args?.path).pipe(
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

export function createGitCommitTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe("Path to the Git repository (defaults to current working directory)"),
      message: z.string().min(1).describe("Commit message"),
      all: z.boolean().optional().describe("Commit all changes in the working directory"),
    })
    .strict();

  type GitCommitArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitCommitArgs>({
    name: "git_commit",
    description:
      "Create a commit to permanently record staged changes in the repository history. Requires a commit message describing the changes. Can commit all staged changes or all working directory changes. Requires user approval before execution.",
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
        .describe("Path to the Git repository (defaults to current working directory)"),
      message: z.string().min(1).describe("Commit message"),
      all: z.boolean().optional().describe("Commit all changes in the working directory"),
    })
    .strict();

  type GitCommitArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitCommitArgs>({
    name: "execute_git_commit",
    description:
      "Internal tool that performs the actual git commit operation after user has approved the git_commit request. Creates a commit with the specified message.",
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

        let workingDirError: string | null = null;
        const workingDir = yield* resolveWorkingDirectory(shell, context, args?.path).pipe(
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
    description:
      "Upload local commits to a remote repository. Pushes the current branch (or specified branch) to the remote (default: origin). Supports force push to overwrite remote history (use with caution). Requires user approval before execution.",
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
    description:
      "Download and merge changes from a remote repository into the current branch. Combines git fetch and git merge. Supports rebase mode to maintain linear history. Use to update your local branch with remote changes. Requires user approval before execution.",
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
    description:
      "Switch to a different branch or create a new branch. Changes the working directory to match the specified branch. Can create new branches or force checkout (discarding local changes). Use to navigate between branches or start work on a new feature branch. Requires user approval before execution.",
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
    description:
      "Internal tool that performs the actual git push operation after user has approved the git_push request. Uploads local commits to the remote repository.",
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

        let workingDirError: string | null = null;
        const workingDir = yield* resolveWorkingDirectory(shell, context, args?.path).pipe(
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
    description:
      "Internal tool that performs the actual git pull operation after user has approved the git_pull request. Downloads and merges changes from the remote repository.",
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

        let workingDirError: string | null = null;
        const workingDir = yield* resolveWorkingDirectory(shell, context, args?.path).pipe(
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
    description:
      "Internal tool that performs the actual git checkout operation after user has approved the git_checkout request. Switches to the specified branch or creates a new branch.",
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

        let workingDirError: string | null = null;
        const workingDir = yield* resolveWorkingDirectory(shell, context, args?.path).pipe(
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
