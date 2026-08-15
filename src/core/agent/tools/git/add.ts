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
 * Git add tools (approval + execution)
 */

const gitAddParameters = z
  .object({
    path: gitRepoPathSchema,
    files: z.array(z.string()).min(1).describe("File paths to stage"),
    all: z.boolean().optional().describe("Stage all modified and untracked files"),
  })
  .strict();

type GitAddArgs = z.infer<typeof gitAddParameters>;

export function createGitAddTools(): ApprovalToolPair<GitToolDeps> {
  const config: ApprovalToolConfig<GitToolDeps, GitAddArgs> = {
    name: "git_add",
    description: "Stage files for the next commit. Specify files or use all:true.",
    tags: ["git", "index"],
    parameters: gitAddParameters,
    validate: makeZodValidator(gitAddParameters),

    approvalMessage: (args: GitAddArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const workingDir = yield* gitApprovalDirectory(args.path, context);

        const filesToAdd = args.all ? "all files" : args.files.join(", ");
        return `Add ${filesToAdd} to git staging\nDirectory: ${workingDir}`;
      }),

    approvalErrorMessage: "Git add requires user confirmation.",

    handler: (args: GitAddArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const resolved = yield* resolveGitRepoDir(args.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const workingDir = resolved.path;

        const addArgs: string[] = ["add"];
        if (args.all) {
          addArgs.push("--all");
        } else {
          addArgs.push(...args.files);
        }

        const executed = yield* runGitOrFail("git add", {
          args: addArgs,
          workingDirectory: workingDir,
        });
        if (executed.kind === "failure") return executed.result;

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            addedFiles: args.all ? "all files" : args.files,
            message: "Files added to staging area",
          },
        };
      }),

    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { addedFiles: string | string[] };
        return `Added ${Array.isArray(gitResult.addedFiles) ? gitResult.addedFiles.join(", ") : gitResult.addedFiles} to staging area`;
      }
      return result.success ? "Files added to Git" : "Git add failed";
    },
  };

  return defineApprovalTool<GitToolDeps, GitAddArgs>(config);
}
