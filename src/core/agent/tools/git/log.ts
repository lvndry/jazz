import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineTool } from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git log tool - displays commit history
 */

export function createGitLogTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe(
          "Path to a file or directory in the Git repository (defaults to current working directory)",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Limit the number of commits to show (default: 20, hard cap: 50)"),
      oneline: z.boolean().optional().describe("Show commits in one-line format"),
    })
    .strict();

  type GitLogArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitLogArgs>({
    name: "git_log",
    description:
      "Display commit history of a Git repository. Shows commit hashes, authors, dates, and messages. Supports limiting results and one-line format for quick overview. Defaults to 20 commits (hard cap 50). Use to review recent changes, find specific commits, or understand repository evolution.",
    tags: ["git", "history"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitLogArgs, context: ToolExecutionContext) =>
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

        const requestedLimit = args?.limit ?? 20;
        const limit = Math.min(requestedLimit, 50);
        const prettyFormat = "%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1e";

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: [
            "log",
            `--max-count=${limit}`,
            `--pretty=format:${prettyFormat}`,
            "--date=relative",
          ],
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git log in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        // If runGitCommand failed (spawn error), return the error
        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git log in directory '${workingDir}'`,
          };
        }

        const gitResult = commandResult;

        if (gitResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error: `git log failed in directory '${workingDir}' with exit code ${gitResult.exitCode}: ${gitResult.stderr || "Unknown error"}`,
          };
        }

        const commits = gitResult.stdout
          .split("\x1e")
          .filter((entry) => entry.trim().length > 0)
          .map((entry) => {
            const [hash, shortHash, author, relativeDate, subject] = entry
              .split("\x1f")
              .map((value) => value.trim());
            return {
              hash,
              shortHash,
              author,
              relativeDate,
              subject,
              oneline: args?.oneline ? `${shortHash} ${subject}` : undefined,
            };
          });

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            commitCount: commits.length,
            commits,
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { commitCount: number };
        return `Retrieved ${gitResult.commitCount} commits from Git history`;
      }
      return result.success ? "Git log retrieved" : "Git log failed";
    },
  });
}
