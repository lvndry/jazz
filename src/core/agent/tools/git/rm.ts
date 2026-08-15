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
 * Git rm tools (approval + execution)
 */

const gitRmParameters = z
  .object({
    path: gitRepoPathSchema,
    files: z.array(z.string()).min(1).describe("Files to remove"),
    cached: z.boolean().optional().describe("Remove from index only (keep on disk)"),
    recursive: z.boolean().optional().describe("Remove directories recursively"),
    force: z.boolean().optional().describe("Force removal"),
  })
  .strict();

type GitRmArgs = z.infer<typeof gitRmParameters>;

export function createGitRmTools(): ApprovalToolPair<GitToolDeps> {
  const config: ApprovalToolConfig<GitToolDeps, GitRmArgs> = {
    name: "git_rm",
    description:
      "Remove files from Git tracking. Supports cached (index only), recursive, and force.",
    tags: ["git", "remove"],
    parameters: gitRmParameters,
    validate: makeZodValidator(gitRmParameters),

    approvalMessage: (args: GitRmArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const workingDir = yield* gitApprovalDirectory(args.path, context);

        const options = [];
        if (args.cached) options.push("index only");
        if (args.recursive) options.push("recursive");
        if (args.force) options.push("force");
        const optionsStr = options.length > 0 ? `\nOptions: ${options.join(", ")}` : "";
        const filesToRemove = args.files.join(", ");
        return `Remove ${filesToRemove} from Git tracking${optionsStr}\nDirectory: ${workingDir}`;
      }),

    approvalErrorMessage: "Git rm requires user confirmation.",

    handler: (args: GitRmArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const resolved = yield* resolveGitRepoDir(args.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const workingDir = resolved.path;

        const rmArgs: string[] = ["rm"];
        if (args.cached) {
          rmArgs.push("--cached");
        }
        if (args.recursive) {
          rmArgs.push("-r");
        }
        if (args.force) {
          rmArgs.push("-f");
        }
        rmArgs.push(...args.files);

        const executed = yield* runGitOrFail("git rm", {
          args: rmArgs,
          workingDirectory: workingDir,
        });
        if (executed.kind === "failure") return executed.result;

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            removedFiles: args.files,
            cached: args.cached || false,
            recursive: args.recursive || false,
            force: args.force || false,
            message: "Files removed from Git tracking",
          },
        };
      }),

    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { removedFiles: string | string[] };
        return `Removed ${Array.isArray(gitResult.removedFiles) ? gitResult.removedFiles.join(", ") : gitResult.removedFiles} from Git tracking`;
      }
      return result.success ? "Files removed from Git" : "Git rm failed";
    },
  };

  return defineApprovalTool<GitToolDeps, GitRmArgs>(config);
}
