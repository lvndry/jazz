import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineTool } from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git status tool - displays repository working tree status
 */

export function createGitStatusTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
    })
    .strict();

  type GitStatusArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitStatusArgs>({
    name: "git_status",
    description:
      "Display the current Git repository status: current branch, modified files, untracked files, and staged changes. Use this BEFORE git_add or git_commit to see what's changed. Also use after file edits to verify changes were applied correctly. This is a read-only operation with no side effects.",
    tags: ["git", "status"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (
      args: GitStatusArgs,
      context: ToolExecutionContext,
    ): Effect.Effect<
      ToolExecutionResult,
      Error,
      FileSystem.FileSystem | FileSystemContextService
    > =>
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

        // Catch spawn errors (e.g., git not found, invalid cwd)
        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: ["status", "--short", "--branch"],
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git status in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git status in directory '${workingDir}'`,
          };
        }

        const gitResult = commandResult;

        if (gitResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error: `git status failed in directory '${workingDir}' with exit code ${gitResult.exitCode}: ${gitResult.stderr || "Unknown error"}`,
          };
        }

        const lines = gitResult.stdout.split("\n").filter((line) => line.trim().length > 0);
        const branchLine = lines.find((line) => line.startsWith("##")) ?? "";
        const changes = lines.filter((line) => !line.startsWith("##"));
        const hasChanges = changes.length > 0;

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            branch: branchLine.replace(/^##\s*/, "") || "unknown",
            hasChanges,
            summary: hasChanges ? changes : ["Working tree clean"],
            rawStatus: gitResult.stdout,
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { hasChanges: boolean; branch?: string };
        const suffix = gitResult.branch ? ` on ${gitResult.branch}` : "";
        return gitResult.hasChanges
          ? `Repository has changes${suffix}`
          : `Repository is clean${suffix}`;
      }
      return result.success ? "Git status retrieved" : "Git status failed";
    },
  });
}
