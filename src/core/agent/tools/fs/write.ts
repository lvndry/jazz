import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import type { ToolExecutionContext } from "@/core/types";
import { generateDiff, generateDiffWithMetadata } from "@/core/utils/diff";
import { FILE_MUTATION_PREVIEW_CHARS } from "@/core/utils/tool-formatter";
import {
  defineApprovalTool,
  makeZodValidator,
  type ApprovalToolConfig,
  type ApprovalToolPair,
} from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Write file tool - writes content to a file.
 * Uses defineApprovalTool to create approval + execution pair.
 */

const writeFileParameters = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        "File to write. Absolute or relative to the session working directory. Created if it does not exist.",
      ),
    content: z
      .string()
      .describe(
        "The complete file contents. This replaces any existing file. Omitting the end of the file deletes it.",
      ),
    createDirs: z
      .boolean()
      .optional()
      .describe("Create missing parent directories. Default false."),
  })
  .strict();

export type WriteFileArgs = z.infer<typeof writeFileParameters>;

type WriteFileDeps = FileSystem.FileSystem | FileSystemContextService;

/**
 * Create write file tools (approval + execution pair).
 * Returns both tools that need to be registered.
 */
export function createWriteFileTools(): ApprovalToolPair<WriteFileDeps> {
  const config: ApprovalToolConfig<WriteFileDeps, WriteFileArgs> = {
    name: "write_file",
    description:
      "Create a new UTF-8 file, or replace an entire existing file. Use this when the file does not exist yet, or when you intend to replace every line. " +
      "To change part of an existing file, use edit_file. Prefer createDirs: true over a separate mkdir when creating a new file. " +
      "content is the complete file — omitting the end deletes it. createDirs defaults to false (unlike mkdir, which creates parents by default).",
    tags: ["filesystem", "write"],
    parameters: writeFileParameters,
    validate: makeZodValidator(writeFileParameters),

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

        // No "press Ctrl+O" here: the message travels to every approver, including a JSON
        // envelope and a chat bridge where there is no keyboard to press it on. Surfaces
        // that do have the affordance offer it themselves off `previewDiff`.

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
          const parentDir = target.substring(0, target.lastIndexOf("/"));
          if (parentDir && parentDir !== target) {
            const parentExists = yield* fs
              .exists(parentDir)
              .pipe(Effect.catchAll(() => Effect.succeed(false)));

            if (!parentExists) {
              if (args.createDirs !== true) {
                return {
                  success: false,
                  result: null,
                  error: `Parent directory does not exist: ${parentDir}. Pass createDirs: true to create it.`,
                };
              }
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
          const needsExpansion =
            wasTruncated ||
            args.content.length > FILE_MUTATION_PREVIEW_CHARS ||
            diff.length > FILE_MUTATION_PREVIEW_CHARS;
          const fullDiff = needsExpansion
            ? generateDiff(originalContent, args.content, target, {
                isNewFile,
                maxLines: Number.POSITIVE_INFINITY,
                fullPatch: true,
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
