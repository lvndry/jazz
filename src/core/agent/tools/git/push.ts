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
 * Git push tools (approval + execution)
 */

const gitPushParameters = z
  .object({
    path: gitRepoPathSchema,
    remote: z.string().optional().describe("Remote name (default: 'origin')"),
    branch: z.string().optional().describe("Branch to push (default: current)"),
    force: z.boolean().optional().describe("Force push (overwrites remote)"),
  })
  .strict();

type GitPushArgs = z.infer<typeof gitPushParameters>;

export function createGitPushTools(): ApprovalToolPair<GitToolDeps> {
  const config: ApprovalToolConfig<GitToolDeps, GitPushArgs> = {
    name: "git_push",
    description: "Push commits to a remote. Supports force push.",
    tags: ["git", "push"],
    parameters: gitPushParameters,
    validate: makeZodValidator(gitPushParameters),

    approvalMessage: (args: GitPushArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const workingDir = yield* gitApprovalDirectory(args.path, context);

        const remote = args.remote || "origin";
        const branch = args.branch || "current branch";
        const force = args.force ? " (FORCE PUSH)" : "";
        return `Push${force} to ${remote}/${branch}\nDirectory: ${workingDir}`;
      }),

    approvalErrorMessage: "Git push requires user confirmation.",

    handler: (args: GitPushArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const resolved = yield* resolveGitRepoDir(args.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const workingDir = resolved.path;

        const remote = args.remote || "origin";
        const branch = args.branch || "";

        const pushArgs: string[] = ["push"];
        if (args.force) {
          pushArgs.push("--force");
        }
        if (branch) {
          pushArgs.push(remote, branch);
        } else {
          pushArgs.push(remote);
        }

        const executed = yield* runGitOrFail("git push", {
          args: pushArgs,
          workingDirectory: workingDir,
        });
        if (executed.kind === "failure") return executed.result;

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            remote,
            branch: branch || "current",
            force: args.force || false,
            message: "Changes pushed successfully",
          },
        };
      }),

    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { remote: string; branch: string; force: boolean };
        return `Pushed to ${gitResult.remote}/${gitResult.branch}${gitResult.force ? " (force)" : ""}`;
      }
      return result.success ? "Git push successful" : "Git push failed";
    },
  };

  return defineApprovalTool<GitToolDeps, GitPushArgs>(config);
}
