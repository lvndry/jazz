import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git checkout tools (approval + execution)
 */

type GitCheckoutArgs = {
  path?: string;
  branch: string;
  create?: boolean;
  force?: boolean;
};

const gitCheckoutParameters = z
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

type GitDeps = FileSystem.FileSystem | FileSystemContextService;

export function createGitCheckoutTools(): ApprovalToolPair<GitDeps> {
  const config: ApprovalToolConfig<GitDeps, GitCheckoutArgs> = {
    name: "git_checkout",
    description:
      "Switch to a different branch or create a new branch. Changes the working directory to match the specified branch. Can create new branches or force checkout (discarding local changes). Use to navigate between branches or start work on a new feature branch.",
    tags: ["git", "checkout"],
    parameters: gitCheckoutParameters,
    validate: (args) => {
      const params = gitCheckoutParameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data as GitCheckoutArgs }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: GitCheckoutArgs, context: ToolExecutionContext) =>
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

        const create = args.create ? " (create new branch)" : "";
        const force = args.force ? " (FORCE - discards changes)" : "";
        return `Checkout branch "${args.branch}"${create}${force}\nDirectory: ${workingDir}`;
      }),

    approvalErrorMessage: "Git checkout requires user confirmation.",

    handler: (args: GitCheckoutArgs, context: ToolExecutionContext) =>
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
  };

  return defineApprovalTool<GitDeps, GitCheckoutArgs>(config);
}
