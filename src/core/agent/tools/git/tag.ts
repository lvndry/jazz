import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineApprovalTool, defineTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git tag tools
 * - List tool: Read-only, no approval required
 * - Create/Delete tools: Mutating operations, require approval
 */

type GitDeps = FileSystem.FileSystem | FileSystemContextService;

/**
 * Git tag list tool - read-only, no approval required
 */
export function createGitTagListTool(): Tool<GitDeps> {
  const parameters = z
    .object({
      path: z
        .string()
        .optional()
        .describe("Path to the Git repository (defaults to current working directory)"),
    })
    .strict();

  type GitTagListArgs = z.infer<typeof parameters>;

  return defineTool<GitDeps, GitTagListArgs>({
    name: "git_tag_list",
    description:
      "List all Git tags. Tags are references to specific points in Git history, commonly used to mark release points (e.g., v1.0.0, v2.1.3). Tags are sorted by creation date (newest first).",
    tags: ["git", "tag", "list"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },
    handler: (args: GitTagListArgs, context: ToolExecutionContext) =>
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
type GitTagArgs = {
  path?: string;
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

export function createGitTagTools(): ApprovalToolPair<GitDeps> {
  const config: ApprovalToolConfig<GitDeps, GitTagArgs> = {
    name: "git_tag",
    description:
      "Create or delete Git tags. Tags are references to specific points in Git history, commonly used to mark release points. Supports lightweight and annotated tags. Use git_tag_list to list existing tags without approval.",
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

        // Neither create nor delete specified
        return `Invalid operation: must specify either 'create' or 'delete'\nDirectory: ${workingDir}`;
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

  return defineApprovalTool<GitDeps, GitTagArgs>(config);
}
