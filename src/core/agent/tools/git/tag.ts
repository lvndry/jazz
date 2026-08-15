import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import {
  defineApprovalTool,
  defineTool,
  makeZodValidator,
  type ApprovalToolConfig,
  type ApprovalToolPair,
} from "../base-tool";
import {
  gitApprovalDirectory,
  gitRepoPathSchema,
  resolveGitRepoDir,
  runGitOrFail,
  withGitTruncation,
  type GitToolDeps,
} from "./utils";

/**
 * Git tag tools
 * - List tool: Read-only, no approval required
 * - Create/Delete tools: Mutating operations, require approval
 */

/**
 * Git tag list tool - read-only, no approval required
 */
export function createGitTagListTool(): Tool<GitToolDeps> {
  const parameters = z
    .object({
      path: gitRepoPathSchema,
    })
    .strict();

  type GitTagListArgs = z.infer<typeof parameters>;

  return defineTool<GitToolDeps, GitTagListArgs>({
    name: "git_tag_list",
    description: "List all Git tags, newest first.",
    tags: ["git", "tag", "list"],
    parameters,
    validate: makeZodValidator(parameters),
    handler: (args: GitTagListArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const resolved = yield* resolveGitRepoDir(args.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const workingDir = resolved.path;

        const executed = yield* runGitOrFail("git tag list", {
          args: ["tag", "--list", "--sort=-creatordate"],
          workingDirectory: workingDir,
        });
        if (executed.kind === "failure") return executed.result;

        const commandResult = executed.result;

        const tags = commandResult.stdout
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((tag) => tag.trim());

        return {
          success: true,
          result: withGitTruncation(
            {
              workingDirectory: workingDir,
              tags,
              tagCount: tags.length,
            },
            commandResult,
          ),
        };
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as { tagCount?: number };
        if (gitResult.tagCount !== undefined) {
          return `Found ${gitResult.tagCount} tags`;
        }
      }
      return result.success ? "Git tag list successful" : "Git tag list failed";
    },
  });
}

/**
 * Git tag create/delete tools - require approval
 */
const gitTagParameters = z
  .object({
    path: gitRepoPathSchema,
    create: z.string().optional().describe("Tag name to create"),
    message: z.string().optional().describe("Annotated tag message"),
    commit: z.string().optional().describe("Commit to tag (default: HEAD)"),
    delete: z.string().optional().describe("Tag name to delete"),
    force: z.boolean().optional().describe("Force (overwrite existing)"),
  })
  .strict();

type GitTagArgs = z.infer<typeof gitTagParameters>;

export function createGitTagTools(): ApprovalToolPair<GitToolDeps> {
  const config: ApprovalToolConfig<GitToolDeps, GitTagArgs> = {
    name: "git_tag",
    description: "Create or delete Git tags. Supports lightweight and annotated.",
    tags: ["git", "tag"],
    parameters: gitTagParameters,
    validate: makeZodValidator(gitTagParameters),

    approvalMessage: (args: GitTagArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const workingDir = yield* gitApprovalDirectory(args.path, context);

        if (args.create) {
          const tagType = args.message ? "annotated" : "lightweight";
          const commit = args.commit ? ` at commit ${args.commit}` : "";
          const force = args.force ? " (force - overwrites existing)" : "";
          return `Create ${tagType} tag "${args.create}"${commit}${force}\nDirectory: ${workingDir}`;
        }

        if (args.delete) {
          const force = args.force ? " (force)" : "";
          return `Delete tag "${args.delete}"${force}\nDirectory: ${workingDir}`;
        }

        // Neither create nor delete specified
        return `Invalid operation: must specify either 'create' or 'delete'\nDirectory: ${workingDir}`;
      }),

    approvalErrorMessage: "Git tag create/delete requires user confirmation.",

    handler: (args: GitTagArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const resolved = yield* resolveGitRepoDir(args.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const workingDir = resolved.path;

        if (args.create) {
          // Create tag
          const tagArgs: string[] = ["tag"];
          if (args.force) {
            tagArgs.push("--force");
          }
          if (args.message) {
            tagArgs.push("-a", args.create, "-m", args.message);
          } else {
            tagArgs.push(args.create);
          }
          if (args.commit) {
            tagArgs.push(args.commit);
          }

          const executed = yield* runGitOrFail("git tag", {
            args: tagArgs,
            workingDirectory: workingDir,
          });
          if (executed.kind === "failure") return executed.result;

          return {
            success: true,
            result: {
              workingDirectory: workingDir,
              tag: args.create,
              message: args.message,
              commit: args.commit || "HEAD",
              force: args.force || false,
              created: true,
            },
          };
        }

        if (args.delete) {
          // Delete tag
          const tagArgs: string[] = ["tag", "--delete"];
          if (args.force) {
            tagArgs.push("--force");
          }
          tagArgs.push(args.delete);

          const executed = yield* runGitOrFail("git tag delete", {
            args: tagArgs,
            workingDirectory: workingDir,
          });
          if (executed.kind === "failure") return executed.result;

          return {
            success: true,
            result: {
              workingDirectory: workingDir,
              tag: args.delete,
              deleted: true,
              force: args.force || false,
            },
          };
        }

        // Neither create nor delete specified - this should not happen as approval message checks this
        return {
          success: false,
          result: null,
          error: "Invalid operation: must specify either 'create' or 'delete'",
        };
      }),

    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as {
          tag?: string;
          deleted?: boolean;
          created?: boolean;
        };
        if (gitResult.deleted) {
          return `Deleted tag: ${gitResult.tag}`;
        }
        if (gitResult.created) {
          return `Created tag: ${gitResult.tag}`;
        }
      }
      return result.success ? "Git tag operation successful" : "Git tag operation failed";
    },
  };

  return defineApprovalTool<GitToolDeps, GitTagArgs>(config);
}
