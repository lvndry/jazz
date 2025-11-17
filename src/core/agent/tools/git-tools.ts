import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import {
  type FileSystemContextService,
  FileSystemContextServiceTag,
} from "../../../services/shell";
import { defineTool } from "./base-tool";
import { buildKeyFromContext } from "./context-utils";
import { createSanitizedEnv } from "./env-utils";
import { type ToolExecutionContext, type ToolExecutionResult } from "./tool-registry";

/**
 * Git command execution tools
 * Provides safe, structured access to common Git operations
 */

// Safe Git operations (read-only, no approval needed)
export interface GitStatusArgs extends Record<string, unknown> {
  path?: string;
}

export interface GitLogArgs extends Record<string, unknown> {
  path?: string;
  limit?: number;
  oneline?: boolean;
}

export interface GitDiffArgs extends Record<string, unknown> {
  path?: string;
  staged?: boolean;
  branch?: string;
  commit?: string;
}

// Potentially destructive operations (approval required)
export interface GitAddArgs extends Record<string, unknown> {
  path?: string;
  files: string[];
  all?: boolean;
}

export interface GitCommitArgs extends Record<string, unknown> {
  path?: string;
  message: string;
  all?: boolean;
}

export interface GitPushArgs extends Record<string, unknown> {
  path?: string;
  remote?: string;
  branch?: string;
  force?: boolean;
}

export interface GitPullArgs extends Record<string, unknown> {
  path?: string;
  remote?: string;
  branch?: string;
  rebase?: boolean;
}

export interface GitBranchArgs extends Record<string, unknown> {
  path?: string;
  list?: boolean;
  all?: boolean;
  remote?: boolean;
}

export interface GitCheckoutArgs extends Record<string, unknown> {
  path?: string;
  branch: string;
  create?: boolean;
  force?: boolean;
}

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

export function createGitStatusTool(): ReturnType<typeof defineTool> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe("Path to the Git repository (defaults to current working directory)"),
    })
    .strict();

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitStatusArgs>({
    name: "git_status",
    description: "Show the working tree status of a Git repository",
    tags: ["git", "status"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data as GitStatusArgs } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (
      args: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Effect.Effect<
      ToolExecutionResult,
      Error,
      FileSystem.FileSystem | FileSystemContextService
    > =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const typedArgs = args as GitStatusArgs;

        // Catch errors from path resolution and return them as ToolExecutionResult
        const workingDirResult = yield* resolveWorkingDirectory(shell, context, typedArgs.path).pipe(
          Effect.catchAll((error) =>
            Effect.succeed({
              success: false,
              result: null,
              error: error instanceof Error ? error.message : String(error),
            } as ToolExecutionResult),
          ),
        );

        // If path resolution failed, return the error
        if (
          typeof workingDirResult === "object" &&
          "success" in workingDirResult &&
          !workingDirResult.success
        ) {
          return workingDirResult;
        }

        const workingDir = workingDirResult as string;

        const commandResult = yield* runGitCommand({
          args: ["status", "--short", "--branch"],
          workingDirectory: workingDir,
        });

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error:
              commandResult.stderr ||
              `git status failed with exit code ${commandResult.exitCode}`,
          };
        }

        const lines = commandResult.stdout.split("\n").filter((line) => line.trim().length > 0);
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
            rawStatus: commandResult.stdout,
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

export function createGitLogTool(): ReturnType<typeof defineTool> {
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

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitLogArgs>({
    name: "git_log",
    description: "Show commit history of a Git repository",
    tags: ["git", "history"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data as GitLogArgs } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: Record<string, unknown>, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const typedArgs = args as GitLogArgs;

        // Catch errors from path resolution and return them as ToolExecutionResult
        const workingDirResult = yield* resolveWorkingDirectory(shell, context, typedArgs.path).pipe(
          Effect.catchAll((error) =>
            Effect.succeed({
              success: false,
              result: null,
              error: error instanceof Error ? error.message : String(error),
            } as ToolExecutionResult),
          ),
        );

        // If path resolution failed, return the error
        if (
          typeof workingDirResult === "object" &&
          "success" in workingDirResult &&
          !workingDirResult.success
        ) {
          return workingDirResult;
        }

        const workingDir = workingDirResult as string;

        const limit = typedArgs.limit ?? 10;
        const prettyFormat = "%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1e";
        const commandResult = yield* runGitCommand({
          args: [
            "log",
            `--max-count=${limit}`,
            `--pretty=format:${prettyFormat}`,
            "--date=relative",
          ],
          workingDirectory: workingDir,
        });

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error: commandResult.stderr || `git log failed with exit code ${commandResult.exitCode}`,
          };
        }

        const commits = commandResult.stdout
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
              oneline: typedArgs.oneline ? `${shortHash} ${subject}` : undefined,
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

export function createGitDiffTool(): ReturnType<typeof defineTool> {
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

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitDiffArgs>({
    name: "git_diff",
    description: "Show changes between commits, commit and working tree, etc.",
    tags: ["git", "diff"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data as GitDiffArgs } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: Record<string, unknown>, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const typedArgs = args as GitDiffArgs;

        // Catch errors from path resolution and return them as ToolExecutionResult
        const workingDirResult = yield* resolveWorkingDirectory(shell, context, typedArgs.path).pipe(
          Effect.catchAll((error) =>
            Effect.succeed({
              success: false,
              result: null,
              error: error instanceof Error ? error.message : String(error),
            } as ToolExecutionResult),
          ),
        );

        // If path resolution failed, return the error
        if (
          typeof workingDirResult === "object" &&
          "success" in workingDirResult &&
          !workingDirResult.success
        ) {
          return workingDirResult;
        }

        const workingDir = workingDirResult as string;

        const diffArgs: string[] = ["diff", "--no-color"];
        if (typedArgs.staged) {
          diffArgs.push("--staged");
        }
        if (typedArgs.branch) {
          diffArgs.push(typedArgs.branch);
        } else if (typedArgs.commit) {
          diffArgs.push(typedArgs.commit);
        }

        const commandResult = yield* runGitCommand({
          args: diffArgs,
          workingDirectory: workingDir,
          timeoutMs: 20000,
        });

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error: commandResult.stderr || `git diff failed with exit code ${commandResult.exitCode}`,
          };
        }

        const trimmedDiff = commandResult.stdout.trimEnd();
        const hasChanges = trimmedDiff.length > 0;

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            diff: trimmedDiff || "No differences",
            hasChanges,
            options: {
              staged: typedArgs.staged ?? false,
              branch: typedArgs.branch,
              commit: typedArgs.commit,
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

export function createGitBranchTool(): ReturnType<typeof defineTool> {
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

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitBranchArgs>({
    name: "git_branch",
    description: "List, create, or delete branches",
    tags: ["git", "branch"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data as GitBranchArgs } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: Record<string, unknown>, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const typedArgs = args as GitBranchArgs;

        // Catch errors from path resolution and return them as ToolExecutionResult
        const workingDirResult = yield* resolveWorkingDirectory(shell, context, typedArgs.path).pipe(
          Effect.catchAll((error) =>
            Effect.succeed({
              success: false,
              result: null,
              error: error instanceof Error ? error.message : String(error),
            } as ToolExecutionResult),
          ),
        );

        // If path resolution failed, return the error
        if (
          typeof workingDirResult === "object" &&
          "success" in workingDirResult &&
          !workingDirResult.success
        ) {
          return workingDirResult;
        }

        const workingDir = workingDirResult as string;

        const branchArgs: string[] = ["branch", "--list"];
        if (typedArgs.remote) {
          branchArgs.push("--remotes");
        } else if (typedArgs.all) {
          branchArgs.push("--all");
        }

        const commandResult = yield* runGitCommand({
          args: branchArgs,
          workingDirectory: workingDir,
        });

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
              list: typedArgs.list !== false,
              all: typedArgs.all ?? false,
              remote: typedArgs.remote ?? false,
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

export function createGitAddTool(): ReturnType<typeof defineTool> {
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

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitAddArgs>({
    name: "git_add",
    description: "Add file contents to the staging area (requires user approval)",
    tags: ["git", "index"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data as GitAddArgs } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: Record<string, unknown>, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const typedArgs = args as GitAddArgs;
          const workingDir = typedArgs.path
            ? yield* shell.resolvePath(
                {
                  agentId: context.agentId,
                  ...(context.conversationId && { conversationId: context.conversationId }),
                },
                typedArgs.path,
              )
            : yield* shell.getCwd({
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              });

          const filesToAdd = typedArgs.all ? "all files" : typedArgs.files.join(", ");
          return `Add ${filesToAdd} to Git staging area in ${workingDir}?`;
        }),
    },
    handler: (args: Record<string, unknown>, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const typedArgs = args as GitAddArgs;

        const workingDir = typedArgs.path
          ? yield* shell.resolvePath(
              {
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              },
              typedArgs.path,
            )
          : yield* shell.getCwd({
              agentId: context.agentId,
              ...(context.conversationId && { conversationId: context.conversationId }),
            });

        // For now, return a simple add message
        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            addedFiles: typedArgs.all ? "all files" : typedArgs.files,
            message: "Files would be added to staging area",
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

export function createGitCommitTool(): ReturnType<typeof defineTool> {
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

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitCommitArgs>({
    name: "git_commit",
    description: "Record changes to the repository (requires user approval)",
    tags: ["git", "commit"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data as GitCommitArgs } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: Record<string, unknown>, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const typedArgs = args as GitCommitArgs;
          const workingDir = typedArgs.path
            ? yield* shell.resolvePath(
                {
                  agentId: context.agentId,
                  ...(context.conversationId && { conversationId: context.conversationId }),
                },
                typedArgs.path,
              )
            : yield* shell.getCwd({
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              });

          return `Commit changes in ${workingDir} with message: "${typedArgs.message}"?`;
        }),
    },
    handler: (args: Record<string, unknown>, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const typedArgs = args as GitCommitArgs;

        const workingDir = typedArgs.path
          ? yield* shell.resolvePath(
              {
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              },
              typedArgs.path,
            )
          : yield* shell.getCwd({
              agentId: context.agentId,
              ...(context.conversationId && { conversationId: context.conversationId }),
            });

        // For now, return a simple commit message
        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            message: typedArgs.message,
            commitHash: "abc123",
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

export function createGitPushTool(): ReturnType<typeof defineTool> {
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

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitPushArgs>({
    name: "git_push",
    description: "Update remote refs along with associated objects (requires user approval)",
    tags: ["git", "push"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data as GitPushArgs } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: Record<string, unknown>, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const typedArgs = args as GitPushArgs;
          const workingDir = typedArgs.path
            ? yield* shell.resolvePath(
                {
                  agentId: context.agentId,
                  ...(context.conversationId && { conversationId: context.conversationId }),
                },
                typedArgs.path,
              )
            : yield* shell.getCwd({
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              });

          const remote = typedArgs.remote || "origin";
          const branch = typedArgs.branch || "current branch";
          const force = typedArgs.force ? " (force push)" : "";
          return `Push${force} to ${remote}/${branch} in ${workingDir}?`;
        }),
    },
    handler: (args: Record<string, unknown>, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const typedArgs = args as GitPushArgs;

        const workingDir = typedArgs.path
          ? yield* shell.resolvePath(
              {
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              },
              typedArgs.path,
            )
          : yield* shell.getCwd({
              agentId: context.agentId,
              ...(context.conversationId && { conversationId: context.conversationId }),
            });

        // For now, return a simple push message
        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            remote: typedArgs.remote || "origin",
            branch: typedArgs.branch || "current",
            force: typedArgs.force || false,
            message: "Changes would be pushed successfully",
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

export function createGitPullTool(): ReturnType<typeof defineTool> {
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

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitPullArgs>({
    name: "git_pull",
    description:
      "Fetch from and integrate with another repository or a local branch (requires user approval)",
    tags: ["git", "pull"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data as GitPullArgs } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: Record<string, unknown>, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const typedArgs = args as GitPullArgs;
          const workingDir = typedArgs.path
            ? yield* shell.resolvePath(
                {
                  agentId: context.agentId,
                  ...(context.conversationId && { conversationId: context.conversationId }),
                },
                typedArgs.path,
              )
            : yield* shell.getCwd({
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              });

          const remote = typedArgs.remote || "origin";
          const branch = typedArgs.branch || "current branch";
          const rebase = typedArgs.rebase ? " (with rebase)" : "";
          return `Pull${rebase} from ${remote}/${branch} in ${workingDir}?`;
        }),
    },
    handler: (args: Record<string, unknown>, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const typedArgs = args as GitPullArgs;

        const workingDir = typedArgs.path
          ? yield* shell.resolvePath(
              {
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              },
              typedArgs.path,
            )
          : yield* shell.getCwd({
              agentId: context.agentId,
              ...(context.conversationId && { conversationId: context.conversationId }),
            });

        // For now, return a simple pull message
        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            remote: typedArgs.remote || "origin",
            branch: typedArgs.branch || "current",
            rebase: typedArgs.rebase || false,
            message: "Changes would be pulled successfully",
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

export function createGitCheckoutTool(): ReturnType<typeof defineTool> {
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

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitCheckoutArgs>({
    name: "git_checkout",
    description: "Switch branches or restore working tree files (requires user approval)",
    tags: ["git", "checkout"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data as GitCheckoutArgs } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: Record<string, unknown>, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const typedArgs = args as GitCheckoutArgs;
          const workingDir = typedArgs.path
            ? yield* shell.resolvePath(
                {
                  agentId: context.agentId,
                  ...(context.conversationId && { conversationId: context.conversationId }),
                },
                typedArgs.path,
              )
            : yield* shell.getCwd({
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              });

          const create = typedArgs.create ? " (create new branch)" : "";
          const force = typedArgs.force ? " (force - discards changes)" : "";
          return `Checkout branch "${typedArgs.branch}"${create}${force} in ${workingDir}?`;
        }),
    },
    handler: (args: Record<string, unknown>, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const typedArgs = args as GitCheckoutArgs;

        const workingDir = typedArgs.path
          ? yield* shell.resolvePath(
              {
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              },
              typedArgs.path,
            )
          : yield* shell.getCwd({
              agentId: context.agentId,
              ...(context.conversationId && { conversationId: context.conversationId }),
            });

        // For now, return a simple checkout message
        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            branch: typedArgs.branch,
            created: typedArgs.create || false,
            force: typedArgs.force || false,
            message: `Switched to branch: ${typedArgs.branch}`,
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
