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
 * Git rm tool - removes files from Git tracking
 */

export function createGitRmTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      files: z.array(z.string()).min(1).describe("Files to remove from Git tracking"),
      cached: z.boolean().optional().describe("Remove from index only (keep in working directory)"),
      recursive: z.boolean().optional().describe("Remove directories recursively"),
      force: z.boolean().optional().describe("Force removal (overrides safety checks)"),
    })
    .strict();

  type GitRmArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitRmArgs>({
    name: "git_rm",
    description: formatApprovalRequiredDescription(
      "Remove files from Git tracking and optionally from the working directory. Removes files from the index (staging area) and can also delete them from the filesystem. Supports removing from index only (cached), recursive directory removal, and force removal. This tool requests user approval and does NOT perform the removal directly. After the user confirms, you MUST call execute_git_rm with the exact arguments provided in the approval response.",
    ),
    tags: ["git", "remove"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: GitRmArgs, context: ToolExecutionContext) =>
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

          const options = [];
          if (args?.cached) options.push("index only");
          if (args?.recursive) options.push("recursive");
          if (args?.force) options.push("force");
          const optionsStr = options.length > 0 ? ` (${options.join(", ")})` : "";
          const filesToRemove = args?.files.join(", ");
          return `Remove ${filesToRemove} from Git tracking${optionsStr} in ${workingDir}?\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_git_rm tool with these exact arguments: {"path": ${args?.path ? `"${args?.path}"` : "undefined"}, "files": ${JSON.stringify(args?.files)}, "cached": ${args?.cached === true}, "recursive": ${args?.recursive === true}, "force": ${args?.force === true}}`;
        }),
      errorMessage: "Approval required: git rm requires user confirmation.",
      execute: {
        toolName: "execute_git_rm",
        buildArgs: (args) => {
          return {
            path: args?.path,
            files: args?.files,
            cached: args?.cached,
            recursive: args?.recursive,
            force: args?.force,
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
        const gitResult = result.result as { removedFiles: string | string[] };
        return `Removed ${Array.isArray(gitResult.removedFiles) ? gitResult.removedFiles.join(", ") : gitResult.removedFiles} from Git tracking`;
      }
      return result.success ? "Files removed from Git" : "Git rm failed";
    },
  });
}

export function createExecuteGitRmTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      files: z.array(z.string()).min(1).describe("Files to remove from Git tracking"),
      cached: z.boolean().optional().describe("Remove from index only (keep in working directory)"),
      recursive: z.boolean().optional().describe("Remove directories recursively"),
      force: z.boolean().optional().describe("Force removal (overrides safety checks)"),
    })
    .strict();

  type GitRmArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitRmArgs>({
    name: "execute_git_rm",
    description: formatExecutionToolDescription(
      "Performs the actual git rm operation after user approval of git_rm. Removes files from Git tracking and optionally from the working directory. This tool should only be called after git_rm receives user approval.",
    ),
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitRmArgs, context: ToolExecutionContext) =>
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

        const rmArgs: string[] = ["rm"];
        if (args?.cached) {
          rmArgs.push("--cached");
        }
        if (args?.recursive) {
          rmArgs.push("-r");
        }
        if (args?.force) {
          rmArgs.push("-f");
        }
        rmArgs.push(...args.files);

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: rmArgs,
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git rm in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git rm in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error: commandResult.stderr || `git rm failed with exit code ${commandResult.exitCode}`,
          };
        }

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            removedFiles: args?.files,
            cached: args?.cached || false,
            recursive: args?.recursive || false,
            force: args?.force || false,
            message: "Files removed from Git tracking",
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { removedFiles: string | string[] };
        return `Removed ${Array.isArray(gitResult.removedFiles) ? gitResult.removedFiles.join(", ") : gitResult.removedFiles} from Git tracking`;
      }
      return result.success ? "Files removed from Git" : "Git rm failed";
    },
  });
}
