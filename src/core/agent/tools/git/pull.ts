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
 * Git pull tool - downloads and merges changes from remote repository
 */

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
