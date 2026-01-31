import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git merge tools (approval + execution)
 */

type GitMergeArgs = {
  path?: string;
  branch: string;
  message?: string;
  noFastForward?: boolean;
  squash?: boolean;
  abort?: boolean;
  strategy?: "resolve" | "recursive" | "octopus" | "ours" | "subtree";
};

const gitMergeParameters = z
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

type GitDeps = FileSystem.FileSystem | FileSystemContextService;

export function createGitMergeTools(): ApprovalToolPair<GitDeps> {
  const config: ApprovalToolConfig<GitDeps, GitMergeArgs> = {
    name: "git_merge",
    description:
      "Merge changes from another branch or commit into the current branch. Combines the history of two branches, creating a merge commit. Supports various merge strategies, squash merging, and fast-forward control. Can also abort an in-progress merge.",
    tags: ["git", "merge"],
    parameters: gitMergeParameters,
    validate: (args) => {
      const params = gitMergeParameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data as GitMergeArgs }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: GitMergeArgs, context: ToolExecutionContext) =>
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

        if (args.abort) {
          return `Abort in-progress merge\nDirectory: ${workingDir}`;
        }

        const options = [];
        if (args.noFastForward) options.push("no fast-forward");
        if (args.squash) options.push("squash");
        if (args.strategy) options.push(`strategy: ${args.strategy}`);
        const optionsStr = options.length > 0 ? `\nOptions: ${options.join(", ")}` : "";
        const messageStr = args.message ? `\nMessage: "${args.message}"` : "";

        return `Merge branch "${args.branch}" into current branch${optionsStr}${messageStr}\nDirectory: ${workingDir}`;
      }),

    approvalErrorMessage: "Git merge requires user confirmation.",

    handler: (args: GitMergeArgs, context: ToolExecutionContext) =>
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

        if (args.abort) {
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

        // Perform merge
        const mergeArgs: string[] = ["merge"];
        if (args.noFastForward) {
          mergeArgs.push("--no-ff");
        }
        if (args.squash) {
          mergeArgs.push("--squash");
        }
        if (args.strategy) {
          mergeArgs.push("--strategy", args.strategy);
        }
        if (args.message) {
          mergeArgs.push("-m", args.message);
        }
        mergeArgs.push(args.branch);

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: mergeArgs,
          workingDirectory: workingDir,
          timeoutMs: 30_000,
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
            message: args.message,
            strategy: args.strategy,
            noFastForward: args.noFastForward || false,
            squash: args.squash || false,
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
  };

  return defineApprovalTool<GitDeps, GitMergeArgs>(config);
}
