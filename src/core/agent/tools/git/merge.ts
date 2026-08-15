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
  GIT_TIMEOUTS,
  getHeadCommitHash,
  gitApprovalDirectory,
  gitRepoPathSchema,
  resolveGitRepoDir,
  runGitOrFail,
  type GitToolDeps,
} from "./utils";

/**
 * Git merge tools (approval + execution)
 */

const gitMergeParameters = z
  .object({
    path: gitRepoPathSchema,
    branch: z.string().min(1).describe("Branch or commit to merge"),
    message: z.string().optional().describe("Merge commit message"),
    noFastForward: z.boolean().optional().describe("Force merge commit (no fast-forward)"),
    squash: z.boolean().optional().describe("Squash into single commit"),
    abort: z.boolean().optional().describe("Abort in-progress merge"),
    strategy: z
      .enum(["resolve", "recursive", "octopus", "ours", "subtree"])
      .optional()
      .describe("Merge strategy to use"),
  })
  .strict();

type GitMergeArgs = z.infer<typeof gitMergeParameters>;

export function createGitMergeTools(): ApprovalToolPair<GitToolDeps> {
  const config: ApprovalToolConfig<GitToolDeps, GitMergeArgs> = {
    name: "git_merge",
    description: "Merge a branch into the current branch. Supports squash, no-ff, and abort.",
    tags: ["git", "merge"],
    parameters: gitMergeParameters,
    validate: makeZodValidator(gitMergeParameters),

    approvalMessage: (args: GitMergeArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const workingDir = yield* gitApprovalDirectory(args.path, context);

        if (args.abort) {
          return `Abort in-progress merge\nDirectory: ${workingDir}`;
        }

        const options = [];
        if (args.noFastForward) options.push("no fast-forward");
        if (args.squash) options.push("squash");
        if (args.strategy) options.push(`strategy: ${args.strategy}`);
        const optionsStr = options.length > 0 ? `\nOptions: ${options.join(", ")}` : "";
        const messageStr = args.message ? `\nMessage: "${args.message}"` : "";

        return `Merge branch "${args.branch}" into current branch${optionsStr}${messageStr}\nDirectory: ${workingDir}`;
      }),

    approvalErrorMessage: "Git merge requires user confirmation.",

    handler: (args: GitMergeArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const resolved = yield* resolveGitRepoDir(args.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const workingDir = resolved.path;

        if (args.abort) {
          const executed = yield* runGitOrFail("git merge --abort", {
            args: ["merge", "--abort"],
            workingDirectory: workingDir,
          });
          if (executed.kind === "failure") return executed.result;

          return {
            success: true,
            result: {
              workingDirectory: workingDir,
              aborted: true,
              message: "Merge aborted successfully",
            },
          };
        }

        // Perform merge
        const mergeArgs: string[] = ["merge"];
        if (args.noFastForward) {
          mergeArgs.push("--no-ff");
        }
        if (args.squash) {
          mergeArgs.push("--squash");
        }
        if (args.strategy) {
          mergeArgs.push("--strategy", args.strategy);
        }
        if (args.message) {
          mergeArgs.push("-m", args.message);
        }
        mergeArgs.push(args.branch);

        const executed = yield* runGitOrFail("git merge", {
          args: mergeArgs,
          workingDirectory: workingDir,
          timeoutMs: GIT_TIMEOUTS.merge,
          failOnNonZero: false,
        });
        if (executed.kind === "failure") return executed.result;

        const commandResult = executed.result;

        if (commandResult.exitCode !== 0) {
          // Merge conflicts or other errors
          const hasConflicts =
            commandResult.stderr.includes("conflict") || commandResult.stderr.includes("CONFLICT");
          return {
            success: false,
            result: {
              workingDirectory: workingDir,
              branch: args.branch,
              hasConflicts,
              error:
                commandResult.stderr || `git merge failed with exit code ${commandResult.exitCode}`,
            },
            error: hasConflicts
              ? "Merge conflicts detected. Please resolve conflicts before continuing."
              : commandResult.stderr || `git merge failed with exit code ${commandResult.exitCode}`,
          };
        }

        const mergeCommitHash = yield* getHeadCommitHash(workingDir);

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            branch: args.branch,
            merged: true,
            mergeCommitHash,
            message: args.message,
            strategy: args.strategy,
            noFastForward: args.noFastForward || false,
            squash: args.squash || false,
          },
        };
      }),

    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { branch?: string; aborted?: boolean; merged?: boolean };
        if (gitResult.aborted) {
          return "Merge aborted";
        }
        if (gitResult.merged) {
          return `Merged ${gitResult.branch || "branch"} into current branch`;
        }
      }
      return result.success ? "Git merge successful" : "Git merge failed";
    },
  };

  return defineApprovalTool<GitToolDeps, GitMergeArgs>(config);
}
