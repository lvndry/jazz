import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git rm tools (approval + execution)
 */

type GitRmArgs = {
  path?: string;
  files: string[];
  cached?: boolean;
  recursive?: boolean;
  force?: boolean;
};

const gitRmParameters = z
  .object({
    path: z.string().optional().describe("Repository path (defaults to cwd)"),
    files: z.array(z.string()).min(1).describe("Files to remove"),
    cached: z.boolean().optional().describe("Remove from index only (keep on disk)"),
    recursive: z.boolean().optional().describe("Remove directories recursively"),
    force: z.boolean().optional().describe("Force removal"),
  })
  .strict();

type GitDeps = FileSystem.FileSystem | FileSystemContextService;

export function createGitRmTools(): ApprovalToolPair<GitDeps> {
  const config: ApprovalToolConfig<GitDeps, GitRmArgs> = {
    name: "git_rm",
    description:
      "Remove files from Git tracking. Supports cached (index only), recursive, and force.",
    tags: ["git", "remove"],
    parameters: gitRmParameters,
    validate: (args) => {
      const params = gitRmParameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data as GitRmArgs }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: GitRmArgs, context: ToolExecutionContext) =>
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

        const options = [];
        if (args.cached) options.push("index only");
        if (args.recursive) options.push("recursive");
        if (args.force) options.push("force");
        const optionsStr = options.length > 0 ? `\nOptions: ${options.join(", ")}` : "";
        const filesToRemove = args.files.join(", ");
        return `Remove ${filesToRemove} from Git tracking${optionsStr}\nDirectory: ${workingDir}`;
      }),

    approvalErrorMessage: "Git rm requires user confirmation.",

    handler: (args: GitRmArgs, context: ToolExecutionContext) =>
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

        const rmArgs: string[] = ["rm"];
        if (args.cached) {
          rmArgs.push("--cached");
        }
        if (args.recursive) {
          rmArgs.push("-r");
        }
        if (args.force) {
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
            removedFiles: args.files,
            cached: args.cached || false,
            recursive: args.recursive || false,
            force: args.force || false,
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
  };

  return defineApprovalTool<GitDeps, GitRmArgs>(config);
}
