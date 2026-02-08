import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git commit tools (approval + execution)
 */

type GitCommitArgs = {
  path?: string;
  message: string;
  all?: boolean;
};

const gitCommitParameters = z
  .object({
    path: z
      .string()
      .optional()
      .describe(
        "Path to a file or directory in the Git repository (defaults to current working directory)",
      ),
    message: z.string().min(1).describe("Commit message describing the changes. Use imperative mood (e.g., 'Add user authentication', 'Fix login redirect bug'). Keep the first line under 72 characters."),
    all: z.boolean().optional().describe("Commit all modified tracked files (skips staging). Prefer using git_add + git_commit separately for more control over what's included."),
  })
  .strict();

type GitDeps = FileSystem.FileSystem | FileSystemContextService;

export function createGitCommitTools(): ApprovalToolPair<GitDeps> {
  const config: ApprovalToolConfig<GitDeps, GitCommitArgs> = {
    name: "git_commit",
    description:
      "Create a git commit from staged changes. Always use git_add first to stage specific files, then commit. Write clear, descriptive commit messages that explain WHY the change was made (not just what changed). If a commit-message skill is available, use it for generating conventional commit messages.",
    tags: ["git", "commit"],
    parameters: gitCommitParameters,
    validate: (args) => {
      const params = gitCommitParameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data as GitCommitArgs }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: GitCommitArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const workingDir = args.path
          ? yield* shell.resolvePath(
              {
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              },
              args.path,
            )
          : yield* shell.getCwd({
              agentId: context.agentId,
              ...(context.conversationId && { conversationId: context.conversationId }),
            });

        return `Commit changes with message: "${args.message}"\nDirectory: ${workingDir}${args.all ? "\nMode: all changes" : ""}`;
      }),

    approvalErrorMessage: "Git commit requires user confirmation.",

    handler: (args: GitCommitArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args.path).pipe(
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
        if (args.all) {
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
            message: args.message,
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
  };

  return defineApprovalTool<GitDeps, GitCommitArgs>(config);
}
