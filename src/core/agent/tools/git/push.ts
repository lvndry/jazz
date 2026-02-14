import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git push tools (approval + execution)
 */

type GitPushArgs = {
  path?: string;
  remote?: string;
  branch?: string;
  force?: boolean;
};

const gitPushParameters = z
  .object({
    path: z.string().optional().describe("Repository path (defaults to cwd)"),
    remote: z.string().optional().describe("Remote name (default: 'origin')"),
    branch: z.string().optional().describe("Branch to push (default: current)"),
    force: z.boolean().optional().describe("Force push (overwrites remote)"),
  })
  .strict();

type GitDeps = FileSystem.FileSystem | FileSystemContextService;

export function createGitPushTools(): ApprovalToolPair<GitDeps> {
  const config: ApprovalToolConfig<GitDeps, GitPushArgs> = {
    name: "git_push",
    description: "Push commits to a remote. Supports force push.",
    tags: ["git", "push"],
    parameters: gitPushParameters,
    validate: (args) => {
      const params = gitPushParameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data as GitPushArgs }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: GitPushArgs, context: ToolExecutionContext) =>
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
        const force = args.force ? " (FORCE PUSH)" : "";
        return `Push${force} to ${remote}/${branch}\nDirectory: ${workingDir}`;
      }),

    approvalErrorMessage: "Git push requires user confirmation.",

    handler: (args: GitPushArgs, context: ToolExecutionContext) =>
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

        const pushArgs: string[] = ["push"];
        if (args.force) {
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
            force: args.force || false,
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
  };

  return defineApprovalTool<GitDeps, GitPushArgs>(config);
}
