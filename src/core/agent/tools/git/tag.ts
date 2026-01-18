import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import {
  defineTool,
  formatExecutionToolDescription
} from "../base-tool";
import { resolveGitWorkingDirectory, runGitCommand } from "./utils";

/**
 * Git tag tool - lists, creates, or deletes Git tags
 */

export function createGitTagTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
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

  type GitTagArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitTagArgs>({
    name: "git_tag",
    description:
      "List, create, or delete Git tags. Tags are references to specific points in Git history, commonly used to mark release points. Listing tags requires no approval. ⚠️ APPROVAL REQUIRED for creating or deleting tags: This tool requests user approval and does NOT perform the tag operation directly. After the user confirms, you MUST call execute_git_tag with the exact arguments provided in the approval response.",
    tags: ["git", "tag"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args: GitTagArgs, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const workingDir = args?.path
            ? yield* shell.resolvePath(
                {
                  agentId: context.agentId,
                  ...(context.conversationId && { conversationId: context.conversationId }),
                },
                args?.path,
              )
            : yield* shell.getCwd({
                agentId: context.agentId,
                ...(context.conversationId && { conversationId: context.conversationId }),
              });

          // If only listing, no approval needed - proceed with listing
          if (!args?.create && !args?.delete) {
            return `Listing tags in ${workingDir} - no approval needed. Proceeding with listing.`;
          }

          if (args?.create) {
            const tagType = args?.message ? "annotated" : "lightweight";
            const commit = args?.commit ? ` at commit ${args.commit}` : "";
            const force = args?.force ? " (force - overwrites existing)" : "";
            return `Create ${tagType} tag "${args.create}"${commit}${force} in ${workingDir}?\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_git_tag tool with these exact arguments: {"path": ${args?.path ? `"${args.path}"` : "undefined"}, "create": "${args.create}", "message": ${args?.message ? JSON.stringify(args.message) : "undefined"}, "commit": ${args?.commit ? `"${args.commit}"` : "undefined"}, "force": ${args?.force === true}}`;
          }

          if (args?.delete) {
            const force = args?.force ? " (force)" : "";
            return `Delete tag "${args.delete}"${force} in ${workingDir}?\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_git_tag tool with these exact arguments: {"path": ${args?.path ? `"${args.path}"` : "undefined"}, "delete": "${args.delete}", "force": ${args?.force === true}}`;
          }

          return "";
        }),
      errorMessage: "Approval required: git tag create/delete requires user confirmation.",
      execute: {
        toolName: "execute_git_tag",
        buildArgs: (args) => {
          return {
            path: args?.path,
            create: args?.create,
            message: args?.message,
            commit: args?.commit,
            delete: args?.delete,
            force: args?.force,
          };
        },
      },
    },
    handler: (args: GitTagArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        // If create or delete is specified, require approval (handled by approval mechanism)
        if (args?.create || args?.delete) {
          return {
            success: false,
            result: null,
            error: "Approval required",
          } as ToolExecutionResult;
        }

        // List tags (safe operation, no approval needed)
        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
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
        const gitResult = result.result as { tagCount?: number; tag?: string; deleted?: boolean };
        if (gitResult.deleted) {
          return `Deleted tag: ${gitResult.tag}`;
        }
        if (gitResult.tag) {
          return `Created tag: ${gitResult.tag}`;
        }
        if (gitResult.tagCount !== undefined) {
          return `Found ${gitResult.tagCount} tags`;
        }
      }
      return result.success ? "Git tag operation successful" : "Git tag operation failed";
    },
  });
}

export function createExecuteGitTagTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
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

  type GitTagArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, GitTagArgs>({
    name: "execute_git_tag",
    description: formatExecutionToolDescription(
      "Performs the actual git tag operation after user approval of git_tag. Creates, deletes, or lists tags in the repository. This tool should only be called after git_tag receives user approval for create/delete operations.",
    ),
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (args: GitTagArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;

        let workingDirError: string | null = null;
        const workingDir = yield* resolveGitWorkingDirectory(shell, context, fs, args?.path).pipe(
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

        if (args?.create) {
          // Create tag
          const tagArgs: string[] = ["tag"];
          if (args?.force) {
            tagArgs.push("--force");
          }
          if (args?.message) {
            tagArgs.push("-a", args.create, "-m", args.message);
          } else {
            tagArgs.push(args.create);
          }
          if (args?.commit) {
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
              message: args?.message,
              commit: args?.commit || "HEAD",
              force: args?.force || false,
              created: true,
            },
          };
        }

        if (args?.delete) {
          // Delete tag
          const tagArgs: string[] = ["tag", "--delete"];
          if (args?.force) {
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
              force: args?.force || false,
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
        const gitResult = result.result as { tag: string; deleted?: boolean; created?: boolean };
        if (gitResult.deleted) {
          return `Deleted tag: ${gitResult.tag}`;
        }
        if (gitResult.created) {
          return `Created tag: ${gitResult.tag}`;
        }
      }
      return result.success ? "Git tag operation successful" : "Git tag operation failed";
    },
  });
}
