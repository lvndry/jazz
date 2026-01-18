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
import { normalizeFilterPattern } from "./utils";

/**
 * Edit file tool - edits specific parts of a file
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

export function createEditFileTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const editOperationSchema = z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("replace_lines"),
        startLine: z
          .number()
          .int()
          .positive()
          .describe("Starting line number (1-based, inclusive)"),
        endLine: z.number().int().positive().describe("Ending line number (1-based, inclusive)"),
        content: z.string().describe("New content to replace the specified lines"),
      })
      .refine((data) => data.startLine <= data.endLine, {
        message: "startLine must be less than or equal to endLine",
      }),
    z.object({
      type: z.literal("replace_pattern"),
      pattern: z
        .string()
        .min(1)
        .describe(
          "Pattern to find (literal string or 're:<regex>' for regex patterns, e.g., 're:function\\s+\\w+')",
        ),
      replacement: z.string().describe("Replacement text"),
      count: z
        .number()
        .int()
        .optional()
        .describe("Number of occurrences to replace (default: 1, use -1 for all occurrences)"),
    }),
    z.object({
      type: z.literal("insert"),
      line: z
        .number()
        .int()
        .nonnegative()
        .describe("Line number to insert after (0-based: 0 = before first line, 1 = after line 1)"),
      content: z.string().describe("Content to insert"),
    }),
    z
      .object({
        type: z.literal("delete_lines"),
        startLine: z
          .number()
          .int()
          .positive()
          .describe("Starting line number (1-based, inclusive)"),
        endLine: z.number().int().positive().describe("Ending line number (1-based, inclusive)"),
      })
      .refine((data) => data.startLine <= data.endLine, {
        message: "startLine must be less than or equal to endLine",
      }),
  ]);

  const parameters = z
    .object({
      path: z
        .string()
        .min(1)
        .describe("File path to edit (relative to cwd allowed, file must exist)"),
      edits: z
        .array(editOperationSchema)
        .min(1)
        .describe(
          "Array of edit operations to perform. Operations are applied in order. Use replace_lines when you know exact line numbers (from read_file, head, tail, grep). Use replace_pattern to find and replace text patterns. Use insert to add new content. Use delete_lines to remove lines.",
        ),
      encoding: z.string().optional().describe("Text encoding (default: utf-8)"),
    })
    .strict();

  return defineTool<FileSystem.FileSystem | FileSystemContextService, EditFileArgs>({
    name: "edit_file",
    description: formatApprovalRequiredDescription(
      "Edit specific parts of a file without rewriting the entire file. This tool requests user approval and does NOT perform the edit operation directly. After the user confirms, you MUST call execute_edit_file with the exact arguments provided in the approval response. Supports multiple edit operations in one call: replace lines by line numbers, replace patterns (regex or literal), insert content at specific lines, or delete lines. Use this when you need to make targeted changes to a file. For line-based edits, use line numbers from read_file, head, tail, or grep. For pattern-based edits, use patterns to find and replace text. All edits are applied in order.",
    ),
    tags: ["filesystem", "write", "edit"],
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? { valid: true, value: result.data as unknown as EditFileArgs }
        : { valid: false, errors: result.error.issues.map((i) => i.message) };
    },
    approval: {
      message: (args, context) =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path);

          // Read the file to show context
          const fs = yield* FileSystem.FileSystem;
          let fileContent = "";
          let totalLines = 0;
          const fileExists = yield* fs
            .exists(target)
            .pipe(Effect.catchAll(() => Effect.succeed(false)));

          if (!fileExists) {
            return `WARNING: File does not exist: ${target}\n\nCannot edit a file that doesn't exist. Please create the file first or check the path.`;
          }

          try {
            fileContent = yield* fs.readFileString(target);
            totalLines = fileContent.split("\n").length;
          } catch {
            return `WARNING: File exists but cannot be read: ${target}\n\nPlease check file permissions.`;
          }

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

          const summary = `About to edit file: ${target} (${totalLines} lines total)\n\nEdits to perform:\n${editDescriptions.join("\n")}\n\nIMPORTANT: After getting user confirmation, you MUST call the execute_edit_file tool with these exact arguments: ${JSON.stringify({ path: args.path, edits: args.edits, encoding: args.encoding ?? "utf-8" })}`;

          return summary;
        }),
      errorMessage: "Approval required: File editing requires user confirmation.",
      execute: {
        toolName: "execute_edit_file",
        buildArgs: (args) => ({
          path: args.path,
          edits: args.edits,
          encoding: args.encoding,
        }),
      },
    },
    handler: (_args) =>
      Effect.succeed({ success: false, result: null, error: "Approval required" }),
  });
}

export function createExecuteEditFileTool(): Tool<
  FileSystem.FileSystem | FileSystemContextService
> {
  const editOperationSchema = z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("replace_lines"),
        startLine: z
          .number()
          .int()
          .positive()
          .describe("Starting line number (1-based, inclusive)"),
        endLine: z.number().int().positive().describe("Ending line number (1-based, inclusive)"),
        content: z.string().describe("New content to replace the specified lines"),
      })
      .refine((data) => data.startLine <= data.endLine, {
        message: "startLine must be less than or equal to endLine",
      }),
    z.object({
      type: z.literal("replace_pattern"),
      pattern: z
        .string()
        .min(1)
        .describe(
          "Pattern to find (literal string or 're:<regex>' for regex patterns, e.g., 're:function\\s+\\w+')",
        ),
      replacement: z.string().describe("Replacement text"),
      count: z
        .number()
        .int()
        .optional()
        .describe("Number of occurrences to replace (default: 1, use -1 for all occurrences)"),
    }),
    z.object({
      type: z.literal("insert"),
      line: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "Line number to insert after (0 = before first line, 1 = after line 1, 2 = after line 2, etc.)",
        ),
      content: z.string().describe("Content to insert"),
    }),
    z
      .object({
        type: z.literal("delete_lines"),
        startLine: z
          .number()
          .int()
          .positive()
          .describe("Starting line number (1-based, inclusive)"),
        endLine: z.number().int().positive().describe("Ending line number (1-based, inclusive)"),
      })
      .refine((data) => data.startLine <= data.endLine, {
        message: "startLine must be less than or equal to endLine",
      }),
  ]);

  const parameters = z
    .object({
      path: z.string().min(1).describe("File path to edit (file must exist)"),
      edits: z.array(editOperationSchema).min(1).describe("Array of edit operations to perform"),
      encoding: z.string().optional().describe("Text encoding (default: utf-8)"),
    })
    .strict();

  return defineTool<FileSystem.FileSystem | FileSystemContextService, EditFileArgs>({
    name: "execute_edit_file",
    description: formatExecutionToolDescription(
      "Performs the actual file edit operation after user approval of edit_file. Applies multiple edit operations to a file in sequence. This tool should only be called after edit_file receives user approval.",
    ),
    hidden: true,
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? { valid: true, value: result.data as unknown as EditFileArgs }
        : { valid: false, errors: result.error.issues.map((i) => i.message) };
    },
    handler: (args, context) =>
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
          // Read the current file content
          const fileContent = yield* fs.readFileString(target);
          const lines = fileContent.split("\n");

          let currentLines = [...lines];
          const appliedEdits: string[] = [];

          // Apply each edit operation in sequence
          for (const edit of args.edits) {
            switch (edit.type) {
              case "replace_lines": {
                // Convert 1-based to 0-based
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
                appliedEdits.push(
                  `Replaced lines ${edit.startLine}-${edit.endLine} with ${newContentLines.length} line(s)`,
                );
                break;
              }

              case "replace_pattern": {
                const patternInfo = normalizeFilterPattern(edit.pattern);
                let content = currentLines.join("\n");
                let replacementCount = 0;
                const maxReplacements = edit.count === -1 ? Infinity : (edit.count ?? 1);

                if (patternInfo.type === "regex" && patternInfo.regex) {
                  // Regex replacement
                  const regex = patternInfo.regex;
                  let match;
                  const matches: Array<{ index: number; length: number }> = [];

                  // Find all matches first
                  while (
                    (match = regex.exec(content)) !== null &&
                    replacementCount < maxReplacements
                  ) {
                    matches.push({ index: match.index, length: match[0].length });
                    replacementCount++;
                    // Prevent infinite loop on zero-length matches
                    if (match.index === regex.lastIndex) {
                      regex.lastIndex++;
                    }
                  }

                  // Replace from end to start to preserve indices
                  for (let i = matches.length - 1; i >= 0; i--) {
                    const m = matches[i];
                    if (m) {
                      content =
                        content.slice(0, m.index) +
                        edit.replacement +
                        content.slice(m.index + m.length);
                    }
                  }
                } else {
                  // Literal string replacement
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
                appliedEdits.push(
                  `Replaced pattern "${edit.pattern}" ${replacementCount} time(s) with "${edit.replacement}"`,
                );
                break;
              }

              case "insert": {
                // Line number directly maps to insertion index (0 = before first line, 1 = after line 1, etc.)
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
                appliedEdits.push(
                  `Inserted ${newContentLines.length} line(s) after line ${edit.line}`,
                );
                break;
              }

              case "delete_lines": {
                // Convert 1-based to 0-based
                const startIdx = edit.startLine - 1;
                const endIdx = edit.endLine - 1;

                if (startIdx < 0 || endIdx >= currentLines.length) {
                  throw new Error(
                    `Line range ${edit.startLine}-${edit.endLine} is out of bounds (file has ${currentLines.length} lines)`,
                  );
                }

                const deletedCount = endIdx - startIdx + 1;
                currentLines = [
                  ...currentLines.slice(0, startIdx),
                  ...currentLines.slice(endIdx + 1),
                ];
                appliedEdits.push(
                  `Deleted lines ${edit.startLine}-${edit.endLine} (${deletedCount} line(s))`,
                );
                break;
              }
            }
          }

          // Write the modified content back
          const newContent = currentLines.join("\n");
          yield* fs.writeFileString(target, newContent);

          return {
            success: true,
            result: {
              path: target,
              editsApplied: appliedEdits,
              totalEdits: args.edits.length,
              originalLines: lines.length,
              newLines: currentLines.length,
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
  });
}
