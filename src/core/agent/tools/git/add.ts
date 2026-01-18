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
 * Git add tool - stages files for commit
 */

export function createGitAddTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      files: z.array(z.string()).min(1).describe("Files to add to the staging area"),
      all: z.boolean().optional().describe("Add all changes in the working directory"),
    })
    .strict();

  type GitAddArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitAddArgs>({
    name: "git_add",
    description: formatApprovalRequiredDescription(
      "Stage files for commit by adding them to Git's index. Prepares changes to be included in the next commit. Can stage specific files or all changes. This tool requests user approval and does NOT perform the staging directly. After the user confirms, you MUST call execute_git_add with the exact arguments provided in the approval response.",
    ),
    tags: ["git", "index"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: GitAddArgs, context: ToolExecutionContext) =>
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

          const filesToAdd = args?.all ? "all files" : args?.files.join(", ");
          return `Add ${filesToAdd} to git staging in ${workingDir}?\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_git_add tool with these exact arguments: {"path": ${args?.path ? `"${args?.path}"` : "undefined"}, "files": ${JSON.stringify(args?.files)}, "all": ${args?.all === true}}`;
        }),
      errorMessage: "Approval required: git add requires user confirmation.",
      execute: {
        toolName: "execute_git_add",
        buildArgs: (args) => {
          return {
            path: args?.path,
            files: args?.files,
            all: args?.all,
          };
        },
      },
    },
    handler: (_args: Record<string, unknown>, _context: ToolExecutionContext) =>
      Effect.succeed({
        success: false,
        result: null,
        error: "Approval required",
      } as ToolExecutionResult),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { addedFiles: string | string[] };
        return `Added ${Array.isArray(gitResult.addedFiles) ? gitResult.addedFiles.join(", ") : gitResult.addedFiles} to staging area`;
      }
      return result.success ? "Files added to Git" : "Git add failed";
    },
  });
}

export function createExecuteGitAddTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      files: z.array(z.string()).min(1).describe("Files to add to the staging area"),
      all: z.boolean().optional().describe("Add all changes in the working directory"),
    })
    .strict();

  type GitAddArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitAddArgs>({
    name: "execute_git_add",
    description: formatExecutionToolDescription(
      "Performs the actual git add operation after user approval of git_add. Stages files for commit by adding them to Git's index. This tool should only be called after git_add receives user approval.",
    ),
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitAddArgs, context: ToolExecutionContext) =>
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

        const addArgs: string[] = ["add"];
        if (args?.all) {
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
            addedFiles: args?.all ? "all files" : args?.files,
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
  });
}
