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
      path: z.string().optional().describe("Repository path (defaults to cwd)"),
      staged: z.boolean().optional().describe("Show staged changes"),
      branch: z.string().optional().describe("Compare with branch"),
      commit: z.string().optional().describe("Compare with commit"),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          "Scope diff to specific files (e.g. ['src/foo.ts', 'docs/bar.md']). Omit for full repo diff.",
        ),
      nameOnly: z
        .boolean()
        .optional()
        .describe("If true, return only the list of changed file paths (git diff --name-only)."),
      maxLines: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max diff lines (default: 500, cap: 2000)"),
    })
    .strict();

  type GitDiffArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitDiffArgs>({
    name: "git_diff",
    description:
      "Show differences between commits, branches, or working tree. Default 500 lines, cap 2000.",
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
        if (args?.nameOnly) {
          diffArgs.push("--name-only");
        }
        if (args?.staged) {
          diffArgs.push("--staged");
        }
        if (args?.branch) {
          diffArgs.push(args.branch);
        } else if (args?.commit) {
          diffArgs.push(args.commit);
        }
        if (args?.paths && args.paths.length > 0) {
          diffArgs.push("--", ...args.paths);
        }

        // Catch spawn errors (e.g., git not found, invalid cwd)
        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: diffArgs,
          workingDirectory: workingDir,
          timeoutMs: 20_000,
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

        const trimmedOutput = gitResult.stdout.trimEnd();

        if (args?.nameOnly) {
          const paths = trimmedOutput ? trimmedOutput.split("\n").filter((p) => p.length > 0) : [];
          return {
            success: true,
            result: {
              workingDirectory: workingDir,
              paths,
              nameOnly: true,
              count: paths.length,
            },
          };
        }

        const hasChanges = trimmedOutput.length > 0;
        const requestedMaxLines = args.maxLines ?? 500;
        const maxLines = Math.min(requestedMaxLines, 2000);
        let diff = trimmedOutput;
        let truncated = false;
        let totalLines = 0;
        let returnedLines = 0;

        if (hasChanges) {
          const lines = trimmedOutput.split("\n");
          totalLines = lines.length;
          if (lines.length > maxLines) {
            diff = lines.slice(0, maxLines).join("\n");
            truncated = true;
            returnedLines = maxLines;
          } else {
            returnedLines = lines.length;
          }
        }

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            paths: args?.paths ?? null,
            diff: diff || "No differences",
            hasChanges,
            truncated,
            totalLines,
            returnedLines,
            options: {
              staged: args.staged ?? false,
              branch: args.branch,
              commit: args.commit,
              paths: args?.paths ?? undefined,
              maxLines,
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
