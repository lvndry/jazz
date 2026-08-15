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
 * Git checkout tools (approval + execution)
 */

const gitCheckoutParameters = z
  .object({
    path: gitRepoPathSchema,
    branch: z.string().min(1).describe("Branch name to switch to or create"),
    create: z.boolean().optional().describe("Create new branch (-b)"),
    force: z.boolean().optional().describe("Force checkout, DISCARDING uncommitted changes"),
  })
  .strict();

type GitCheckoutArgs = z.infer<typeof gitCheckoutParameters>;

export function createGitCheckoutTools(): ApprovalToolPair<GitToolDeps> {
  const config: ApprovalToolConfig<GitToolDeps, GitCheckoutArgs> = {
    name: "git_checkout",
    description:
      "Switch branches or create a new branch (create:true). force discards uncommitted changes.",
    tags: ["git", "checkout"],
    parameters: gitCheckoutParameters,
    validate: makeZodValidator(gitCheckoutParameters),

    approvalMessage: (args: GitCheckoutArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const workingDir = yield* gitApprovalDirectory(args.path, context);

        const create = args.create ? " (create new branch)" : "";
        const force = args.force ? " (FORCE - discards changes)" : "";
        return `Checkout branch "${args.branch}"${create}${force}\nDirectory: ${workingDir}`;
      }),

    approvalErrorMessage: "Git checkout requires user confirmation.",

    handler: (args: GitCheckoutArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const resolved = yield* resolveGitRepoDir(args.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const workingDir = resolved.path;

        const checkoutArgs: string[] = ["checkout"];
        if (args.create) {
          checkoutArgs.push("-b");
        }
        if (args.force) {
          checkoutArgs.push("--force");
        }
        checkoutArgs.push(args.branch);

        const executed = yield* runGitOrFail("git checkout", {
          args: checkoutArgs,
          workingDirectory: workingDir,
        });
        if (executed.kind === "failure") return executed.result;

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            branch: args.branch,
            created: args.create || false,
            force: args.force || false,
            message: `Switched to branch: ${args.branch}`,
          },
        };
      }),

    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { branch: string; created: boolean };
        return `Switched to ${gitResult.branch}${gitResult.created ? " (newly created)" : ""}`;
      }
      return result.success ? "Git checkout successful" : "Git checkout failed";
    },
  };

  return defineApprovalTool<GitToolDeps, GitCheckoutArgs>(config);
}
