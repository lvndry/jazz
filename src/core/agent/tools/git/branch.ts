import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineTool, makeZodValidator } from "../base-tool";
import {
  gitRepoPathSchema,
  resolveGitRepoDir,
  runGitOrFail,
  withGitTruncation,
  type GitToolDeps,
} from "./utils";

/**
 * Git branch tool - lists Git branches
 */

export function createGitBranchTool(): Tool<GitToolDeps> {
  const parameters = z
    .object({
      path: gitRepoPathSchema,
      list: z.boolean().optional().describe("List branches"),
      all: z.boolean().optional().describe("Include remote branches"),
      remote: z.boolean().optional().describe("Remote branches only"),
    })
    .strict();

  type GitBranchArgs = z.infer<typeof parameters>;

  return defineTool<GitToolDeps, GitBranchArgs>({
    name: "git_branch",
    description: "List branches (local, remote, or both) and show current branch.",
    tags: ["git", "branch"],
    parameters,
    validate: makeZodValidator(parameters),
    handler: (args: GitBranchArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const resolved = yield* resolveGitRepoDir(args?.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const workingDir = resolved.path;

        const branchArgs: string[] = ["branch", "--list"];
        if (args?.remote) {
          branchArgs.push("--remotes");
        } else if (args?.all) {
          branchArgs.push("--all");
        }

        const executed = yield* runGitOrFail("git branch", {
          args: branchArgs,
          workingDirectory: workingDir,
        });
        if (executed.kind === "failure") return executed.result;

        const commandResult = executed.result;

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
          result: withGitTruncation(
            {
              workingDirectory: workingDir,
              branches,
              currentBranch,
              options: {
                list: args?.list !== false,
                all: args?.all ?? false,
                remote: args?.remote ?? false,
              },
            },
            commandResult,
          ),
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
