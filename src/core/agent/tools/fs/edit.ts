import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext } from "@/core/types";
import { generateDiff, generateDiffWithMetadata } from "@/core/utils/diff-utils";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";
import { normalizeFilterPattern } from "./utils";

/**
 * Edit file tool - edits specific parts of a file
 * Uses defineApprovalTool to create approval + execution pair.
 */

export type EditOperation =
  | {
      type: "replace_lines";
      startLine: number;
      endLine: number;
      content: string;
    }
  | {
      type: "replace_pattern";
      pattern: string;
      replacement: string;
      count?: number;
    }
  | {
      type: "insert";
      line: number;
      content: string;
    }
  | {
      type: "delete_lines";
      startLine: number;
      endLine: number;
    };

export type EditFileArgs = {
  path: string;
  edits: EditOperation[];
  encoding?: string;
};

const editOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("replace_lines"),
      startLine: z.number().int().positive().describe("Start line (1-based)"),
      endLine: z.number().int().positive().describe("End line (1-based)"),
      content: z.string().describe("Replacement content"),
    })
    .refine((data) => data.startLine <= data.endLine, {
      message: "startLine must be less than or equal to endLine",
    }),
  z.object({
    type: z.literal("replace_pattern"),
    pattern: z.string().min(1).describe("Literal string or 're:<regex>' pattern to find"),
    replacement: z.string().describe("Replacement text"),
    count: z.number().int().optional().describe("Occurrences to replace (default: 1, -1 for all)"),
  }),
  z.object({
    type: z.literal("insert"),
    line: z.number().int().nonnegative().describe("Insert after this line (0 = before first line)"),
    content: z.string().describe("Content to insert"),
  }),
  z
    .object({
      type: z.literal("delete_lines"),
      startLine: z.number().int().positive().describe("Start line (1-based)"),
      endLine: z.number().int().positive().describe("End line (1-based)"),
    })
    .refine((data) => data.startLine <= data.endLine, {
      message: "startLine must be less than or equal to endLine",
    }),
]);

const editFileParameters = z
  .object({
    path: z.string().min(1).describe("File path to edit (must exist)"),
    edits: z
      .array(editOperationSchema)
      .min(1)
      .describe(
        "Edit operations to apply in order: replace_lines, replace_pattern, insert, delete_lines.",
      ),
    encoding: z.string().optional().describe("Text encoding (default: utf-8)"),
  })
  .strict();

type EditFileDeps = FileSystem.FileSystem | FileSystemContextService;

/**
 * Result of applying an edit operation
 */
interface ApplyEditResult {
  /** Description of what was applied */
  description: string;
}

/**
 * Apply a sequence of edit operations to file lines.
 * Pure function that throws on invalid operations (e.g., out-of-bounds).
 *
 * @param lines - The original file lines
 * @param edits - The edit operations to apply
 * @returns Object with resultLines and array of descriptions for each applied edit
 */
function applyEdits(
  lines: readonly string[],
  edits: readonly EditOperation[],
): { resultLines: string[]; appliedEdits: ApplyEditResult[] } {
  let currentLines = [...lines];
  const appliedEdits: ApplyEditResult[] = [];

  for (const edit of edits) {
    switch (edit.type) {
      case "replace_lines": {
        const startIdx = edit.startLine - 1;
        const endIdx = edit.endLine - 1;

        if (startIdx < 0 || endIdx >= currentLines.length) {
          throw new Error(
            `Line range ${edit.startLine}-${edit.endLine} is out of bounds (file has ${currentLines.length} lines)`,
          );
        }

        const newContentLines = edit.content.split("\n");
        currentLines = [
          ...currentLines.slice(0, startIdx),
          ...newContentLines,
          ...currentLines.slice(endIdx + 1),
        ];
        appliedEdits.push({
          description: `Replaced lines ${edit.startLine}-${edit.endLine} with ${newContentLines.length} line(s)`,
        });
        break;
      }

      case "replace_pattern": {
        const patternInfo = normalizeFilterPattern(edit.pattern);
        let content = currentLines.join("\n");
        let replacementCount = 0;
        const maxReplacements = edit.count === -1 ? Infinity : (edit.count ?? 1);

        if (patternInfo.type === "regex" && patternInfo.regex) {
          const regex = patternInfo.regex;
          let match;
          const matches: Array<{ index: number; length: number }> = [];

          while ((match = regex.exec(content)) !== null && replacementCount < maxReplacements) {
            matches.push({ index: match.index, length: match[0].length });
            replacementCount++;
            if (match.index === regex.lastIndex) {
              regex.lastIndex++;
            }
          }

          for (let i = matches.length - 1; i >= 0; i--) {
            const m = matches[i];
            if (m) {
              content =
                content.slice(0, m.index) + edit.replacement + content.slice(m.index + m.length);
            }
          }
        } else {
          const searchStr = patternInfo.value || edit.pattern;
          let searchIndex = 0;
          while (
            replacementCount < maxReplacements &&
            (searchIndex = content.indexOf(searchStr, searchIndex)) !== -1
          ) {
            content =
              content.slice(0, searchIndex) +
              edit.replacement +
              content.slice(searchIndex + searchStr.length);
            replacementCount++;
            searchIndex += edit.replacement.length;
          }
        }

        currentLines = content.split("\n");
        appliedEdits.push({
          description: `Replaced pattern "${edit.pattern}" ${replacementCount} time(s) with "${edit.replacement}"`,
        });
        break;
      }

      case "insert": {
        const insertIdx = edit.line;
        const newContentLines = edit.content.split("\n");

        if (insertIdx < 0 || insertIdx > currentLines.length) {
          throw new Error(
            `Insert position ${edit.line} is out of bounds (file has ${currentLines.length} lines)`,
          );
        }

        currentLines = [
          ...currentLines.slice(0, insertIdx),
          ...newContentLines,
          ...currentLines.slice(insertIdx),
        ];
        appliedEdits.push({
          description: `Inserted ${newContentLines.length} line(s) after line ${edit.line}`,
        });
        break;
      }

      case "delete_lines": {
        const startIdx = edit.startLine - 1;
        const endIdx = edit.endLine - 1;

        if (startIdx < 0 || endIdx >= currentLines.length) {
          throw new Error(
            `Line range ${edit.startLine}-${edit.endLine} is out of bounds (file has ${currentLines.length} lines)`,
          );
        }

        const deletedCount = endIdx - startIdx + 1;
        currentLines = [...currentLines.slice(0, startIdx), ...currentLines.slice(endIdx + 1)];
        appliedEdits.push({
          description: `Deleted lines ${edit.startLine}-${edit.endLine} (${deletedCount} line(s))`,
        });
        break;
      }
    }
  }

  return { resultLines: currentLines, appliedEdits };
}

/**
 * Create edit file tools (approval + execution pair).
 */
export function createEditFileTools(): ApprovalToolPair<EditFileDeps> {
  const config: ApprovalToolConfig<EditFileDeps, EditFileArgs> = {
    name: "edit_file",
    description:
      "Edit parts of a file: replace lines, replace patterns, insert, or delete. Edits applied in order.",
    tags: ["filesystem", "write", "edit"],
    parameters: editFileParameters,
    validate: (args) => {
      const result = editFileParameters.safeParse(args);
      return result.success
        ? { valid: true, value: result.data as unknown as EditFileArgs }
        : { valid: false, errors: result.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: EditFileArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path);

        const fs = yield* FileSystem.FileSystem;
        const fileExists = yield* fs
          .exists(target)
          .pipe(Effect.catchAll(() => Effect.succeed(false)));

        if (!fileExists) {
          return `WARNING: File does not exist: ${target}\n\nCannot edit a file that doesn't exist.`;
        }

        let fileContent: string;
        try {
          fileContent = yield* fs.readFileString(target);
        } catch {
          return `WARNING: File exists but cannot be read: ${target}`;
        }

        const lines = fileContent.split("\n");
        const totalLines = lines.length;

        const editDescriptions = args.edits.map((edit, idx) => {
          switch (edit.type) {
            case "replace_lines":
              return `  ${idx + 1}. Replace lines ${edit.startLine}-${edit.endLine} with new content (${edit.content.split("\n").length} lines)`;
            case "replace_pattern":
              return `  ${idx + 1}. Replace pattern "${edit.pattern}" with "${edit.replacement}"${edit.count ? ` (${edit.count} occurrence${edit.count === 1 ? "" : "s"})` : " (first occurrence)"}`;
            case "insert":
              return `  ${idx + 1}. Insert content after line ${edit.line} (${edit.content.split("\n").length} lines)`;
            case "delete_lines":
              return `  ${idx + 1}. Delete lines ${edit.startLine}-${edit.endLine}`;
          }
        });

        // Simulate edits to generate preview diff using shared helper
        let simulationError: string | null = null;
        let resultLines: string[] = lines;

        try {
          const result = applyEdits(lines, args.edits);
          resultLines = result.resultLines;
        } catch (error) {
          simulationError = error instanceof Error ? error.message : "Error simulating edit";
        }

        const message = `About to edit file: ${target} (${totalLines} lines total)\n\nEdits to perform:\n${editDescriptions.join("\n")}\n\n${simulationError ? `⚠️ ${simulationError}` : "Press Ctrl+O to preview changes"}`;

        // Generate full diff for Ctrl+O expansion
        if (!simulationError) {
          const newContent = resultLines.join("\n");
          const { diff } = generateDiffWithMetadata(fileContent, newContent, target, {
            maxLines: Number.POSITIVE_INFINITY,
          });
          return { message, previewDiff: diff };
        }

        return message;
      }),

    handler: (args: EditFileArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path);

        const fileExists = yield* fs
          .exists(target)
          .pipe(Effect.catchAll(() => Effect.succeed(false)));

        if (!fileExists) {
          return {
            success: false,
            result: null,
            error: `File does not exist: ${target}. Cannot edit a file that doesn't exist.`,
          };
        }

        try {
          const fileContent = yield* fs.readFileString(target);
          const lines = fileContent.split("\n");

          // Apply edits using the shared helper function
          const { resultLines, appliedEdits } = applyEdits(lines, args.edits);

          const newContent = resultLines.join("\n");
          yield* fs.writeFileString(target, newContent);

          const { diff, wasTruncated } = generateDiffWithMetadata(fileContent, newContent, target);
          const fullDiff = wasTruncated
            ? generateDiff(fileContent, newContent, target, {
                maxLines: Number.POSITIVE_INFINITY,
              })
            : "";

          return {
            success: true,
            result: {
              path: target,
              editsApplied: appliedEdits.map((e) => e.description),
              totalEdits: args.edits.length,
              originalLines: lines.length,
              newLines: resultLines.length,
              diff,
              wasTruncated,
              fullDiff,
            },
          };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `editFile failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  };

  return defineApprovalTool<EditFileDeps, EditFileArgs>(config);
}
