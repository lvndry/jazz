import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import {
  defineTool,
  formatApprovalRequiredDescription,
  formatExecutionToolDescription,
} from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git commit tool - creates commits with staged changes
 */

export function createGitCommitTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      message: z.string().min(1).describe("Commit message"),
      all: z.boolean().optional().describe("Commit all changes in the working directory"),
    })
    .strict();

  type GitCommitArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitCommitArgs>({
    name: "git_commit",
    description: formatApprovalRequiredDescription(
      "Create a commit to permanently record staged changes in the repository history. Requires a commit message describing the changes. Can commit all staged changes or all working directory changes. This tool requests user approval and does NOT perform the commit directly. After the user confirms, you MUST call execute_git_commit with the exact arguments provided in the approval response.",
    ),
    tags: ["git", "commit"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: GitCommitArgs, context: ToolExecutionContext) =>
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

          return `Commit changes in ${workingDir} with message: "${args?.message}"?\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_git_commit tool with these exact arguments: {"path": ${args?.path ? `"${args?.path}"` : "undefined"}, "message": ${JSON.stringify(args?.message)}, "all": ${args?.all === true}}`;
        }),
      errorMessage: "Approval required: git commit requires user confirmation.",
      execute: {
        toolName: "execute_git_commit",
        buildArgs: (args) => {
          return {
            path: args?.path,
            message: args?.message,
            all: args?.all,
          };
        },
      },
    },
    handler: (_args: GitCommitArgs, _context: ToolExecutionContext) =>
      Effect.succeed({
        success: false,
        result: null,
        error: "Approval required",
      } as ToolExecutionResult),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { message: string; commitHash: string };
        return `Committed: "${gitResult.message}" (${gitResult.commitHash})`;
      }
      return result.success ? "Git commit created" : "Git commit failed";
    },
  });
}

export function createExecuteGitCommitTool(): Tool<
  FileSystem.FileSystem | FileSystemContextService
> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      message: z.string().min(1).describe("Commit message"),
      all: z.boolean().optional().describe("Commit all changes in the working directory"),
    })
    .strict();

  type GitCommitArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitCommitArgs>({
    name: "execute_git_commit",
    description: formatExecutionToolDescription(
      "Performs the actual git commit operation after user approval of git_commit. Creates a commit with the specified message. This tool should only be called after git_commit receives user approval.",
    ),
    hidden: true,
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitCommitArgs, context: ToolExecutionContext) =>
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

        const commitArgs: string[] = ["commit", "-m", args.message];
        if (args?.all) {
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
            message: args?.message,
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
  });
}
