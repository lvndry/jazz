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
 * Git status tool - displays repository working tree status
 */

export function createGitStatusTool(): Tool<GitToolDeps> {
  const parameters = z
    .object({
      path: gitRepoPathSchema,
    })
    .strict();

  type GitStatusArgs = z.infer<typeof parameters>;

  return defineTool<GitToolDeps, GitStatusArgs>({
    name: "git_status",
    description: "Show current branch, modified files, staged changes, and untracked files.",
    tags: ["git", "status"],
    parameters,
    validate: makeZodValidator(parameters),
    handler: (
      args: GitStatusArgs,
      context: ToolExecutionContext,
    ): Effect.Effect<ToolExecutionResult, Error, GitToolDeps> =>
      Effect.gen(function* () {
        const resolved = yield* resolveGitRepoDir(args?.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const workingDir = resolved.path;

        const executed = yield* runGitOrFail("git status", {
          args: ["status", "--short", "--branch"],
          workingDirectory: workingDir,
        });
        if (executed.kind === "failure") return executed.result;

        const gitResult = executed.result;

        const lines = gitResult.stdout.split("\n").filter((line) => line.trim().length > 0);
        const branchLine = lines.find((line) => line.startsWith("##")) ?? "";
        const changes = lines.filter((line) => !line.startsWith("##"));
        const hasChanges = changes.length > 0;

        return {
          success: true,
          result: withGitTruncation(
            {
              workingDirectory: workingDir,
              branch: branchLine.replace(/^##\s*/, "") || "unknown",
              hasChanges,
              summary: hasChanges ? changes : ["Working tree clean"],
              rawStatus: gitResult.stdout,
            },
            gitResult,
          ),
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
