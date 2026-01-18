import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "../../../interfaces/fs";
import type { Tool } from "../../../interfaces/tool-registry";
import {
  defineTool,
  formatApprovalRequiredDescription,
  formatExecutionToolDescription,
} from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Write file tool - writes content to a file
 */

export type WriteFileArgs = { path: string; content: string; encoding?: string; createDirs?: boolean };

export function createWriteFileTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .min(1)
        .describe(
          "File path to write to, will be created if it doesn't exist (relative to cwd allowed)",
        ),
      content: z.string().describe("Content to write to the file"),
      encoding: z.string().optional().describe("Text encoding (currently utf-8)"),
      createDirs: z.boolean().optional().describe("Create parent directories if they don't exist"),
    })
    .strict();

  return defineTool<FileSystem.FileSystem | FileSystemContextService, WriteFileArgs>({
    name: "write_file",
    description: formatApprovalRequiredDescription(
      "Write content to a file, creating it if it doesn't exist. This tool requests user approval and does NOT perform the write operation directly. After the user confirms, you MUST call execute_write_file with the exact arguments provided in the approval response.",
    ),
    tags: ["filesystem", "write"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data as unknown as WriteFileArgs }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },
    approval: {
      message: (args, context) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path, {
            skipExistenceCheck: true,
          });
          return `About to write to file: ${target}${args.createDirs === true ? " (will create parent directories)" : ""}.\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_write_file tool with these exact arguments: {"path": "${args.path}", "content": ${JSON.stringify(args.content)}, "encoding": "${args.encoding ?? "utf-8"}", "createDirs": ${args.createDirs === true}}`;
        }),
      errorMessage: "Approval required: File writing requires user confirmation.",
      execute: {
        toolName: "execute_write_file",
        buildArgs: (args) => ({
          path: args.path,
          content: args.content,
          encoding: args.encoding,
          createDirs: args.createDirs,
        }),
      },
    },
    handler: (_args) =>
      Effect.succeed({ success: false, result: null, error: "Approval required" }),
  });
}

export function createExecuteWriteFileTool(): Tool<
  FileSystem.FileSystem | FileSystemContextService
> {
  const parameters = z
    .object({
      path: z
        .string()
        .min(1)
        .describe("File path to write to, will be created if it doesn't exist"),
      content: z.string().describe("Content to write to the file"),
      encoding: z.string().optional().describe("Text encoding (currently utf-8)"),
      createDirs: z.boolean().optional().describe("Create parent directories if they don't exist"),
    })
    .strict();

  return defineTool<FileSystem.FileSystem | FileSystemContextService, WriteFileArgs>({
    name: "execute_write_file",
    description: formatExecutionToolDescription(
      "Performs the actual file write operation after user approval of write_file. Creates or overwrites the file at the specified path with the provided content. This tool should only be called after write_file receives user approval.",
    ),
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data as unknown as WriteFileArgs }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path, {
          skipExistenceCheck: true,
        });

        try {
          const parentDir = target.substring(0, target.lastIndexOf("/"));
          if (parentDir && parentDir !== target) {
            const parentExists = yield* fs
              .exists(parentDir)
              .pipe(Effect.catchAll(() => Effect.succeed(false)));

            if (!parentExists) {
              yield* fs.makeDirectory(parentDir, { recursive: true });
            }
          }

          // Write the file content
          yield* fs.writeFileString(target, args.content);

          return { success: true, result: `File written: ${target}` };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `writeFile failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}
