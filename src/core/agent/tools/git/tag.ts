import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git tag tools (approval + execution)
 * Note: Tag listing is also handled here but doesn't require approval
 */

type GitTagArgs = {
  path?: string;
  list?: boolean;
  create?: string;
  message?: string;
  commit?: string;
  delete?: string;
  force?: boolean;
};

const gitTagParameters = z
  .object({
    path: z
      .string()
      .optional()
      .describe("Path to the Git repository (defaults to current working directory)"),
    list: z.boolean().optional().describe("List all tags"),
    create: z.string().optional().describe("Create a new tag with the specified name"),
    message: z
      .string()
      .optional()
      .describe("Annotated tag message (required if creating an annotated tag)"),
    commit: z.string().optional().describe("Create tag at specific commit (defaults to HEAD)"),
    delete: z.string().optional().describe("Delete a tag with the specified name"),
    force: z
      .boolean()
      .optional()
      .describe("Force tag creation/deletion (overwrites existing tags)"),
  })
  .strict();

type GitDeps = FileSystem.FileSystem | FileSystemContextService;

export function createGitTagTools(): ApprovalToolPair<GitDeps> {
  const config: ApprovalToolConfig<GitDeps, GitTagArgs> = {
    name: "git_tag",
    description:
      "List, create, or delete Git tags. Tags are references to specific points in Git history, commonly used to mark release points. Supports lightweight and annotated tags.",
    tags: ["git", "tag"],
    parameters: gitTagParameters,
    validate: (args) => {
      const params = gitTagParameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data as GitTagArgs }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: GitTagArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const workingDir = args.path
          ? yield* shell.resolvePath(
              {
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              },
              args.path,
            )
          : yield* shell.getCwd({
              agentId: context.agentId,
              ...(context.conversationId && { conversationId: context.conversationId }),
            });

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

        // List tags (no approval needed, but message is still generated)
        return `List tags\nDirectory: ${workingDir}`;
      }),

    approvalErrorMessage: "Git tag create/delete requires user confirmation.",

    handler: (args: GitTagArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args.path).pipe(
          Effect.catchAll((error) => {
            workingDirError = error instanceof Error ? error.message : String(error);
            return Effect.succeed(null);
          }),
        );

        if (workingDir === null) {
          return {
            success: false,
            result: null,
            error: workingDirError || "Failed to resolve working directory",
          };
        }

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

          let commandError: string | null = null;
          const commandResult = yield* runGitCommand({
            args: tagArgs,
            workingDirectory: workingDir,
          }).pipe(
            Effect.catchAll((error) => {
              const errorMsg = error instanceof Error ? error.message : String(error);
              commandError = `Failed to execute git tag in directory '${workingDir}': ${errorMsg}`;
              return Effect.succeed(null);
            }),
          );

          if (commandResult === null) {
            return {
              success: false,
              result: null,
              error: commandError || `Failed to execute git tag in directory '${workingDir}'`,
            };
          }

          if (commandResult.exitCode !== 0) {
            return {
              success: false,
              result: null,
              error:
                commandResult.stderr || `git tag failed with exit code ${commandResult.exitCode}`,
            };
          }

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

          let commandError: string | null = null;
          const commandResult = yield* runGitCommand({
            args: tagArgs,
            workingDirectory: workingDir,
          }).pipe(
            Effect.catchAll((error) => {
              const errorMsg = error instanceof Error ? error.message : String(error);
              commandError = `Failed to execute git tag delete in directory '${workingDir}': ${errorMsg}`;
              return Effect.succeed(null);
            }),
          );

          if (commandResult === null) {
            return {
              success: false,
              result: null,
              error:
                commandError || `Failed to execute git tag delete in directory '${workingDir}'`,
            };
          }

          if (commandResult.exitCode !== 0) {
            return {
              success: false,
              result: null,
              error:
                commandResult.stderr ||
                `git tag delete failed with exit code ${commandResult.exitCode}`,
            };
          }

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

        // List tags (when neither create nor delete is specified)
        let commandError: string | null = null;
        const commandResult = yield* runGitCommand({
          args: ["tag", "--list", "--sort=-creatordate"],
          workingDirectory: workingDir,
        }).pipe(
          Effect.catchAll((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            commandError = `Failed to execute git tag list in directory '${workingDir}': ${errorMsg}`;
            return Effect.succeed(null);
          }),
        );

        if (commandResult === null) {
          return {
            success: false,
            result: null,
            error: commandError || `Failed to execute git tag list in directory '${workingDir}'`,
          };
        }

        if (commandResult.exitCode !== 0) {
          return {
            success: false,
            result: null,
            error:
              commandResult.stderr ||
              `git tag list failed with exit code ${commandResult.exitCode}`,
          };
        }

        const tags = commandResult.stdout
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((tag) => tag.trim());

        return {
          success: true,
          result: {
            workingDirectory: workingDir,
            tags,
            tagCount: tags.length,
          },
        };
      }),

    createSummary: (result: ToolExecutionResult) => {
      if (result.success && typeof result.result === "object" && result.result !== null) {
        const gitResult = result.result as {
          tagCount?: number;
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
        if (gitResult.tagCount !== undefined) {
          return `Found ${gitResult.tagCount} tags`;
        }
      }
      return result.success ? "Git tag operation successful" : "Git tag operation failed";
    },
  };

  return defineApprovalTool<GitDeps, GitTagArgs>(config);
}
