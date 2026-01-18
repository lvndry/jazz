import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineTool } from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git diff tool - shows differences between commits, branches, or working tree
 */

export function createGitDiffTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      staged: z.boolean().optional().describe("Show staged changes (cached)"),
      branch: z.string().optional().describe("Compare with a specific branch"),
      commit: z.string().optional().describe("Compare with a specific commit"),
    })
    .strict();

  type GitDiffArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitDiffArgs>({
    name: "git_diff",
    description:
      "Display differences between commits, branches, or working tree. Shows what has changed in files (additions, deletions, modifications). Use to review changes before committing, compare branches, or see what differs from a specific commit. Supports staged changes and branch comparisons.",
    tags: ["git", "diff"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitDiffArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        // Catch errors from path resolution
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

        const diffArgs: string[] = ["diff", "--no-color"];
        if (args?.staged) {
          diffArgs.push("--staged");
        }
        if (args?.branch) {
          diffArgs.push(args.branch);
        } else if (args?.commit) {
          diffArgs.push(args.commit);
        }

        // Catch spawn errors (e.g., git not found, invalid cwd)
        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: diffArgs,
          workingDirectory: workingDir,
          timeoutMs: 20000,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git diff in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        // If runGitCommand failed (spawn error), return the error
        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git diff in directory '${workingDir}'`,
          };
        }

        const gitResult = commandResult;

        if (gitResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error: `git diff failed in directory '${workingDir}' with exit code ${gitResult.exitCode}: ${gitResult.stderr || "Unknown error"}`,
          };
        }

        const trimmedDiff = gitResult.stdout.trimEnd();
        const hasChanges = trimmedDiff.length > 0;

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            diff: trimmedDiff || "No differences",
            hasChanges,
            options: {
              staged: args.staged ?? false,
              branch: args.branch,
              commit: args.commit,
            },
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { hasChanges: boolean };
        return gitResult.hasChanges ? "Repository has differences" : "No differences found";
      }
      return result.success ? "Git diff retrieved" : "Git diff failed";
    },
  });
}
