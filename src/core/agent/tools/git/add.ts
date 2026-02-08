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
    path: z
      .string()
      .optional()
      .describe(
        "Path to a file or directory in the Git repository (defaults to current working directory)",
      ),
    files: z.array(z.string()).min(1).describe("Specific file paths to stage (e.g., ['src/index.ts', 'README.md']). Prefer listing explicit files over using 'all'."),
    all: z.boolean().optional().describe("Stage ALL modified and untracked files. Use with caution — prefer listing specific files to avoid staging unrelated changes."),
  })
  .strict();

type GitDeps = FileSystem.FileSystem | FileSystemContextService;

export function createGitAddTools(): ApprovalToolPair<GitDeps> {
  const config: ApprovalToolConfig<GitDeps, GitAddArgs> = {
    name: "git_add",
    description:
      "Stage files for the next git commit. Always run git_status first to see what's changed, then stage specific files by path. Prefer staging specific files over using 'all: true' to avoid accidentally committing unrelated changes. Use git_diff with staged: true to review what you're about to commit.",
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
            error: commandResult.stderr || `git add failed with exit code ${commandResult.exitCode}`,
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
