import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "../../../interfaces/fs";
import type { Tool } from "../../../interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "../../../types";
import {
  defineTool,
  formatApprovalRequiredDescription,
  formatExecutionToolDescription,
} from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git merge tool - merges branches together
 */

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
