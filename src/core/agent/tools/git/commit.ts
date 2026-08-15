import { Effect } from "effect";
import { z } from "zod";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import {
  defineApprovalTool,
  makeZodValidator,
  type ApprovalToolConfig,
  type ApprovalToolPair,
} from "../base-tool";
import {
  getHeadCommitHash,
  gitApprovalDirectory,
  gitRepoPathSchema,
  resolveGitRepoDir,
  runGitOrFail,
  type GitToolDeps,
} from "./utils";

/**
 * Git commit tools (approval + execution)
 */

const gitCommitParameters = z
  .object({
    path: gitRepoPathSchema,
    message: z
      .string()
      .min(1)
      .describe("Commit message. Imperative mood, first line under 72 chars."),
    all: z.boolean().optional().describe("Commit all modified tracked files, skipping staging."),
  })
  .strict();

type GitCommitArgs = z.infer<typeof gitCommitParameters>;

export function createGitCommitTools(): ApprovalToolPair<GitToolDeps> {
  const config: ApprovalToolConfig<GitToolDeps, GitCommitArgs> = {
    name: "git_commit",
    description: "Create a commit from staged changes. Use git_add first to stage files.",
    tags: ["git", "commit"],
    parameters: gitCommitParameters,
    validate: makeZodValidator(gitCommitParameters),

    approvalMessage: (args: GitCommitArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const workingDir = yield* gitApprovalDirectory(args.path, context);

        return `Commit changes with message: "${args.message}"\nDirectory: ${workingDir}${args.all ? "\nMode: all changes" : ""}`;
      }),

    approvalErrorMessage: "Git commit requires user confirmation.",

    handler: (args: GitCommitArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const resolved = yield* resolveGitRepoDir(args.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const workingDir = resolved.path;

        const commitArgs: string[] = ["commit", "-m", args.message];
        if (args.all) {
          commitArgs.push("--all");
        }

        const executed = yield* runGitOrFail("git commit", {
          args: commitArgs,
          workingDirectory: workingDir,
        });
        if (executed.kind === "failure") return executed.result;

        const commitHash = yield* getHeadCommitHash(workingDir);

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            message: args.message,
            commitHash,
          },
        };
      }),

    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { message: string; commitHash: string };
        return `Committed: "${gitResult.message}" (${gitResult.commitHash})`;
      }
      return result.success ? "Git commit created" : "Git commit failed";
    },
  };

  return defineApprovalTool<GitToolDeps, GitCommitArgs>(config);
}
