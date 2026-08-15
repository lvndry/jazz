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
  gitApprovalDirectory,
  gitRepoPathSchema,
  resolveGitRepoDir,
  runGitOrFail,
  type GitToolDeps,
} from "./utils";

/**
 * Git pull tools (approval + execution)
 */

const gitPullParameters = z
  .object({
    path: gitRepoPathSchema,
    remote: z.string().optional().describe("Remote name (default: 'origin')"),
    branch: z.string().optional().describe("Branch to pull (default: current)"),
    rebase: z.boolean().optional().describe("Rebase instead of merge"),
  })
  .strict();

type GitPullArgs = z.infer<typeof gitPullParameters>;

export function createGitPullTools(): ApprovalToolPair<GitToolDeps> {
  const config: ApprovalToolConfig<GitToolDeps, GitPullArgs> = {
    name: "git_pull",
    description: "Pull changes from a remote. Supports rebase mode.",
    tags: ["git", "pull"],
    parameters: gitPullParameters,
    validate: makeZodValidator(gitPullParameters),

    approvalMessage: (args: GitPullArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const workingDir = yield* gitApprovalDirectory(args.path, context);

        const remote = args.remote || "origin";
        const branch = args.branch || "current branch";
        const rebase = args.rebase ? " (with rebase)" : "";
        return `Pull${rebase} from ${remote}/${branch}\nDirectory: ${workingDir}`;
      }),

    approvalErrorMessage: "Git pull requires user confirmation.",

    handler: (args: GitPullArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const resolved = yield* resolveGitRepoDir(args.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const workingDir = resolved.path;

        const remote = args.remote || "origin";
        const branch = args.branch || "";

        const pullArgs: string[] = ["pull"];
        if (args.rebase) {
          pullArgs.push("--rebase");
        }
        if (branch) {
          pullArgs.push(remote, branch);
        } else {
          pullArgs.push(remote);
        }

        const executed = yield* runGitOrFail("git pull", {
          args: pullArgs,
          workingDirectory: workingDir,
        });
        if (executed.kind === "failure") return executed.result;

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            remote,
            branch: branch || "current",
            rebase: args.rebase || false,
            message: "Changes pulled successfully",
          },
        };
      }),

    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { remote: string; branch: string; rebase: boolean };
        return `Pulled from ${gitResult.remote}/${gitResult.branch}${gitResult.rebase ? " (rebase)" : ""}`;
      }
      return result.success ? "Git pull successful" : "Git pull failed";
    },
  };

  return defineApprovalTool<GitToolDeps, GitPullArgs>(config);
}
