import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import {
  defineTool,
  formatApprovalRequiredDescription,
  formatExecutionToolDescription,
} from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Remove files or directories tool
 */

export function createRmTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("File or directory to remove"),
      recursive: z.boolean().optional().describe("Recursively remove directories"),
      force: z.boolean().optional().describe("Ignore non-existent files and errors"),
    })
    .strict();

  type RmArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, RmArgs>({
    name: "rm",
    description: formatApprovalRequiredDescription(
      "Remove a file or directory, optionally recursively. This tool requests user approval and does NOT perform the deletion directly. After the user confirms, you MUST call execute_rm with the exact arguments provided in the approval response.",
    ),
    tags: ["filesystem", "destructive"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? {
            valid: true,
            value: params.data,
          }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },
    approval: {
      message: (args, context) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path);
          const recurse = args.recursive === true ? " recursively" : "";
          return `About to delete${recurse}: ${target}. This action may be irreversible.\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_rm tool with the same arguments: {"path": "${args.path}", "recursive": ${args.recursive === true}, "force": ${args.force === true}}`;
        }),
      errorMessage: "Approval required: File/directory deletion requires user confirmation.",
      execute: {
        toolName: "execute_rm",
        buildArgs: (args) => ({
          path: (args as { path: string }).path,
          recursive: (args as { recursive?: boolean }).recursive,
          force: (args as { force?: boolean }).force,
        }),
      },
    },
    handler: (_args) =>
      Effect.succeed({ success: false, result: null, error: "Approval required" }),
  });
}

export function createExecuteRmTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("File or directory to remove"),
      recursive: z.boolean().optional().describe("Recursively remove directories"),
      force: z.boolean().optional().describe("Ignore non-existent files and errors"),
    })
    .strict();

  type ExecuteRmArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, ExecuteRmArgs>({
    name: "execute_rm",
    description: formatExecutionToolDescription(
      "Performs the actual file/directory removal after user approval of rm. Deletes the specified path, optionally recursively for directories. This tool should only be called after rm receives user approval.",
    ),
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? {
            valid: true,
            value: params.data,
          }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path);
        try {
          // Basic safeguards: do not allow deleting root or home dir directly
          if (target === "/" || target === process.env["HOME"]) {
            return {
              success: false,
              result: null,
              error: `Refusing to remove critical path: ${target}`,
            };
          }
          // If not recursive and target is directory, error
          const st = yield* fs
            .stat(target)
            .pipe(
              Effect.catchAll((err) =>
                args.force ? Effect.fail(err as Error) : Effect.fail(err as Error),
              ),
            );
          if (st.type === "Directory" && args.recursive !== true) {
            return {
              success: false,
              result: null,
              error: `Path is a directory, use recursive: true`,
            };
          }
          yield* fs.remove(target, {
            recursive: args.recursive === true,
            force: args.force === true,
          });
          return { success: true, result: `Removed: ${target}` };
        } catch (error) {
          if (args.force) {
            return {
              success: true,
              result: `Removal attempted with force; error ignored: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          return {
            success: false,
            result: null,
            error: `rm failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}
