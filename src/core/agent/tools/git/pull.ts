import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git pull tools (approval + execution)
 */

type GitPullArgs = {
  path?: string;
  remote?: string;
  branch?: string;
  rebase?: boolean;
};

const gitPullParameters = z
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

type GitDeps = FileSystem.FileSystem | FileSystemContextService;

export function createGitPullTools(): ApprovalToolPair<GitDeps> {
  const config: ApprovalToolConfig<GitDeps, GitPullArgs> = {
    name: "git_pull",
    description:
      "Download and merge changes from a remote repository into the current branch. Combines git fetch and git merge. Supports rebase mode to maintain linear history. Use to update your local branch with remote changes.",
    tags: ["git", "pull"],
    parameters: gitPullParameters,
    validate: (args) => {
      const params = gitPullParameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data as GitPullArgs }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: GitPullArgs, context: ToolExecutionContext) =>
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

        const remote = args.remote || "origin";
        const branch = args.branch || "current branch";
        const rebase = args.rebase ? " (with rebase)" : "";
        return `Pull${rebase} from ${remote}/${branch}\nDirectory: ${workingDir}`;
      }),

    approvalErrorMessage: "Git pull requires user confirmation.",

    handler: (args: GitPullArgs, context: ToolExecutionContext) =>
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

        const remote = args.remote || "origin";
        const branch = args.branch || "";

        const pullArgs: string[] = ["pull"];
        if (args.rebase) {
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
            rebase: args.rebase || false,
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
  };

  return defineApprovalTool<GitDeps, GitPullArgs>(config);
}
