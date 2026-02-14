import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git add tools (approval + execution)
 */

type GitAddArgs = {
  path?: string;
  files: string[];
  all?: boolean;
};

const gitAddParameters = z
  .object({
    path: z.string().optional().describe("Repository path (defaults to cwd)"),
    files: z.array(z.string()).min(1).describe("File paths to stage"),
    all: z.boolean().optional().describe("Stage all modified and untracked files"),
  })
  .strict();

type GitDeps = FileSystem.FileSystem | FileSystemContextService;

export function createGitAddTools(): ApprovalToolPair<GitDeps> {
  const config: ApprovalToolConfig<GitDeps, GitAddArgs> = {
    name: "git_add",
    description: "Stage files for the next commit. Specify files or use all:true.",
    tags: ["git", "index"],
    parameters: gitAddParameters,
    validate: (args) => {
      const params = gitAddParameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data as GitAddArgs }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: GitAddArgs, context: ToolExecutionContext) =>
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

        const filesToAdd = args.all ? "all files" : args.files.join(", ");
        return `Add ${filesToAdd} to git staging\nDirectory: ${workingDir}`;
      }),

    approvalErrorMessage: "Git add requires user confirmation.",

    handler: (args: GitAddArgs, context: ToolExecutionContext) =>
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

        const addArgs: string[] = ["add"];
        if (args.all) {
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
            addedFiles: args.all ? "all files" : args.files,
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
  };

  return defineApprovalTool<GitDeps, GitAddArgs>(config);
}
