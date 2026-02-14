import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext } from "@/core/types";
import { generateDiff, generateDiffWithMetadata } from "@/core/utils/diff-utils";
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
    path: z.string().min(1).describe("File path (created if it doesn't exist)"),
    content: z.string().describe("Full file content (replaces existing content)"),
    encoding: z.string().optional().describe("Text encoding (default: utf-8)"),
    createDirs: z
      .boolean()
      .optional()
      .describe("Create parent directories if missing (default: false)"),
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
    description: "Write content to a file, creating it if needed. Replaces entire file content.",
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
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path, {
          skipExistenceCheck: true,
        });
        const options = args.createDirs ? " (will create parent directories)" : "";

        // Check if file exists and read original content for preview diff
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

        // Build message with overwrite warning if applicable
        let message = `About to write ${args.content.length} characters to file: ${target}${options}`;

        if (!isNewFile && originalContent.length > 0) {
          message += `\n\n⚠️  WARNING: This will overwrite the existing file (${originalContent.split("\n").length} lines).`;
          message += `\n   Consider using edit_file instead if you only need to modify part of the file.`;
        }

        message += `\n\nPress Ctrl+O to preview changes`;

        // Generate full diff for Ctrl+O expansion
        const { diff } = generateDiffWithMetadata(originalContent, args.content, target, {
          isNewFile,
          maxLines: Number.POSITIVE_INFINITY,
        });

        return { message, previewDiff: diff };
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
          const { diff, wasTruncated } = generateDiffWithMetadata(
            originalContent,
            args.content,
            target,
            { isNewFile },
          );
          const fullDiff = wasTruncated
            ? generateDiff(originalContent, args.content, target, {
                isNewFile,
                maxLines: Number.POSITIVE_INFINITY,
              })
            : "";

          return {
            success: true,
            result: {
              path: target,
              message: isNewFile ? `File created: ${target}` : `File written: ${target}`,
              isNewFile,
              diff,
              wasTruncated,
              fullDiff,
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
