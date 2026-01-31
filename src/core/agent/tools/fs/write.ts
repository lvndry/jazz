import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext } from "@/core/types";
import { generateDiff } from "@/core/utils/diff-utils";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Write file tool - writes content to a file.
 * Uses defineApprovalTool to create approval + execution pair.
 */

export type WriteFileArgs = {
  path: string;
  content: string;
  encoding?: string;
  createDirs?: boolean;
};

const writeFileParameters = z
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

type WriteFileDeps = FileSystem.FileSystem | FileSystemContextService;

/**
 * Create write file tools (approval + execution pair).
 * Returns both tools that need to be registered.
 */
export function createWriteFileTools(): ApprovalToolPair<WriteFileDeps> {
  const config: ApprovalToolConfig<WriteFileDeps, WriteFileArgs> = {
    name: "write_file",
    description:
      "Write content to a file, creating it if it doesn't exist. Supports creating parent directories.",
    tags: ["filesystem", "write"],
    parameters: writeFileParameters,
    validate: (args) => {
      const result = writeFileParameters.safeParse(args);
      return result.success
        ? { valid: true, value: result.data as WriteFileArgs }
        : { valid: false, errors: result.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: WriteFileArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path, {
          skipExistenceCheck: true,
        });
        const options = args.createDirs ? " (will create parent directories)" : "";
        return `About to write ${args.content.length} characters to file: ${target}${options}`;
      }),

    handler: (args: WriteFileArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path, {
          skipExistenceCheck: true,
        });

        try {
          // Create parent directories if needed
          const parentDir = target.substring(0, target.lastIndexOf("/"));
          if (parentDir && parentDir !== target) {
            const parentExists = yield* fs
              .exists(parentDir)
              .pipe(Effect.catchAll(() => Effect.succeed(false)));

            if (!parentExists) {
              yield* fs.makeDirectory(parentDir, { recursive: true });
            }
          }

          // Check if file exists and read original content for diff
          const fileExists = yield* fs
            .exists(target)
            .pipe(Effect.catchAll(() => Effect.succeed(false)));

          let originalContent = "";
          const isNewFile = !fileExists;

          if (fileExists) {
            try {
              originalContent = yield* fs.readFileString(target);
            } catch {
              // If we can't read, treat as new file
            }
          }

          // Write the file content
          yield* fs.writeFileString(target, args.content);

          // Generate diff for terminal output
          const diff = generateDiff(originalContent, args.content, target, { isNewFile });

          return {
            success: true,
            result: {
              path: target,
              message: isNewFile ? `File created: ${target}` : `File written: ${target}`,
              isNewFile,
              diff,
            },
          };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `writeFile failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  };


  return defineApprovalTool<WriteFileDeps, WriteFileArgs>(config);
}
