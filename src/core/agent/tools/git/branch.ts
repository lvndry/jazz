import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineTool } from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git branch tool - lists Git branches
 */

export function createGitBranchTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().optional().describe("Repository path (defaults to cwd)"),
      list: z.boolean().optional().describe("List branches"),
      all: z.boolean().optional().describe("Include remote branches"),
      remote: z.boolean().optional().describe("Remote branches only"),
    })
    .strict();

  type GitBranchArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitBranchArgs>({
    name: "git_branch",
    description: "List branches (local, remote, or both) and show current branch.",
    tags: ["git", "branch"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitBranchArgs, context: ToolExecutionContext) =>
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

        const branchArgs: string[] = ["branch", "--list"];
        if (args?.remote) {
          branchArgs.push("--remotes");
        } else if (args?.all) {
          branchArgs.push("--all");
        }

        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: branchArgs,
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git branch in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git branch in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error:
              commandResult.stderr || `git branch failed with exit code ${commandResult.exitCode}`,
          };
        }

        const lines = commandResult.stdout.split("\n").filter((line) => line.trim().length > 0);
        let currentBranch: string | undefined;
        const branches = lines.map((line) => {
          const trimmed = line.replace(/^\*\s*/, "").trim();
          if (line.trim().startsWith("*")) {
            currentBranch = trimmed;
          }
          return trimmed;
        });

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            branches,
            currentBranch,
            options: {
              list: args?.list !== false,
              all: args?.all ?? false,
              remote: args?.remote ?? false,
            },
          },
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { branches: string[]; currentBranch?: string };
        return `Found ${gitResult.branches.length} branches${
          gitResult.currentBranch ? ` (current: ${gitResult.currentBranch})` : ""
        }`;
      }
      return result.success ? "Git branches retrieved" : "Git branch failed";
    },
  });
}
