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
 * Create directory tool
 */

export function createMkdirTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("Directory path to create"),
      recursive: z.boolean().optional().describe("Create parent directories as needed"),
    })
    .strict();

  type MkdirArgs = z.infer<typeof parameters>;
  return defineTool<FileSystem.FileSystem | FileSystemContextService, MkdirArgs>({
    name: "mkdir",
    description: formatApprovalRequiredDescription(
      "Create a directory, optionally creating parent directories as needed. This tool requests user approval and does NOT perform the directory creation directly. After the user confirms, you MUST call execute_mkdir with the exact arguments provided in the approval response.",
    ),
    tags: ["filesystem", "write"],
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
          const fs = yield* FileSystem.FileSystem;
          const target = yield* shell.resolvePathForMkdir(buildKeyFromContext(context), args.path);

          // Check if directory already exists
          const statResult = yield* fs
            .stat(target)
            .pipe(Effect.catchAll(() => Effect.succeed(null)));

          if (statResult) {
            if (statResult.type === "Directory") {
              return `Directory already exists: ${target}\n\nNo action needed - the directory is already present.`;
            } else {
              return `Path exists but is not a directory: ${target}\n\nCannot create directory at this location because a file already exists.`;
            }
          }

          return `About to create directory: ${target}${args.recursive === false ? "" : " (with parents)"}.\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_mkdir tool with these exact arguments: {"path": "${args.path}", "recursive": ${args.recursive !== false}}`;
        }),
      errorMessage: "Approval required: Directory creation requires user confirmation.",
      execute: {
        toolName: "execute_mkdir",
        buildArgs: (args) => ({
          path: (args as { path: string; recursive?: boolean }).path,
          recursive: (args as { path: string; recursive?: boolean }).recursive,
        }),
      },
    },
    handler: (_args) =>
      Effect.succeed({ success: false, result: null, error: "Approval required" }),
  });
}

export function createExecuteMkdirTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("Directory path to create"),
      recursive: z.boolean().optional().describe("Create parent directories as needed"),
    })
    .strict();

  type ExecuteMkdirArgs = z.infer<typeof parameters>;
  return defineTool<FileSystem.FileSystem | FileSystemContextService, ExecuteMkdirArgs>({
    name: "execute_mkdir",
    description: formatExecutionToolDescription(
      "Performs the actual directory creation after user approval of mkdir. Creates the directory at the specified path, optionally creating parent directories. This tool should only be called after mkdir receives user approval.",
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
        const target = yield* shell.resolvePathForMkdir(buildKeyFromContext(context), args.path);

        // Check if directory already exists
        const statResult = yield* fs.stat(target).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (statResult) {
          if (statResult.type === "Directory") {
            return { success: true, result: `Directory already exists: ${target}` };
          } else {
            return {
              success: false,
              result: null,
              error: `Cannot create directory '${target}': a file already exists at this path`,
            };
          }
        }

        try {
          yield* fs.makeDirectory(target, { recursive: args.recursive !== false });
          return { success: true, result: `Directory created: ${target}` };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `mkdir failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}
