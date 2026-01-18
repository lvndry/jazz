import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineTool } from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git reflog tool - shows reference log of HEAD updates
 */

export function createGitReflogTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
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
        .max(1000)
        .optional()
        .describe("Limit the number of reflog entries to show"),
      branch: z
        .string()
        .optional()
        .describe("Show reflog for a specific branch (defaults to HEAD)"),
      all: z.boolean().optional().describe("Show reflog for all branches"),
      oneline: z.boolean().optional().describe("Show entries in one-line format"),
    })
    .strict();

  type GitReflogArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitReflogArgs>({
    name: "git_reflog",
    description:
      "Display the reference log showing where HEAD and branch references have been. Shows commit hashes, actions (checkout, commit, merge, etc.), and timestamps. Useful for recovering lost commits, understanding branch history, or tracking reference movements. Supports filtering by branch and limiting results.",
    tags: ["git", "reflog", "history"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitReflogArgs, context: ToolExecutionContext) =>
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

        const limit = args?.limit ?? 20;
        const reflogArgs: string[] = ["reflog", "--no-color"];

        if (args?.all) {
          reflogArgs.push("--all");
        } else if (args?.branch) {
          reflogArgs.push(args.branch);
        }

        if (limit > 0) {
          reflogArgs.push(`-n${limit}`);
        }

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: reflogArgs,
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git reflog in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git reflog in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error:
              commandResult.stderr || `git reflog failed with exit code ${commandResult.exitCode}`,
          };
        }

        // Parse reflog output format: <commit-hash> HEAD@{n}: <action>: <summary>
        // Example: abc1234 HEAD@{0}: checkout: moving from main to feature
        const entries = commandResult.stdout
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            // Match: <hash> <ref>@{<n>}: <action>: <summary>
            const match = line.match(/^(\S+)\s+(\S+@\{\d+\}):\s+(.+?)(?::\s+(.+))?$/);
            if (match && match.length >= 4) {
              const hash = match[1] || "unknown";
              const ref = match[2] || "unknown";
              const action = match[3] || "unknown";
              const summary = match[4] || "";

              // Extract short hash (first 7 characters)
              const shortHash = hash.length >= 7 ? hash.substring(0, 7) : hash;

              return {
                hash,
                shortHash,
                ref,
                action: action.trim(),
                summary: summary.trim(),
                oneline: args?.oneline
                  ? `${shortHash} ${ref}: ${action}${summary ? `: ${summary}` : ""}`
                  : undefined,
              };
            }
            // Fallback if parsing fails
            return {
              hash: "unknown",
              shortHash: "unknown",
              ref: "unknown",
              action: "unknown",
              summary: line,
              oneline: args?.oneline ? line : undefined,
            };
          });

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            entryCount: entries.length,
            entries,
            options: {
              limit,
              branch: args?.branch,
              all: args?.all ?? false,
              oneline: args?.oneline ?? false,
            },
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { entryCount: number };
        return `Retrieved ${gitResult.entryCount} reflog entries`;
      }
      return result.success ? "Git reflog retrieved" : "Git reflog failed";
    },
  });
}
