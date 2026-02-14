import { FileSystem } from "@effect/platform";
import { Data, Effect } from "effect";
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

// ============================================================================
// Tagged Error Types
// ============================================================================

/**
 * File not found error
 */
export class FileNotFoundError extends Data.TaggedError("FileNotFoundError")<{
  readonly path: string;
}> {
  override get message() {
    return `File does not exist: ${this.path}. Cannot edit a file that doesn't exist.`;
  }
}

/**
 * File cannot be read error
 */
export class FileReadError extends Data.TaggedError("FileReadError")<{
  readonly path: string;
  readonly cause?: unknown;
}> {
  override get message() {
    const causeStr =
      this.cause instanceof Error
        ? this.cause.message
        : typeof this.cause === "string"
          ? this.cause
          : typeof this.cause === "object" && this.cause !== null
            ? JSON.stringify(this.cause)
            : String(this.cause);
    return `File exists but cannot be read: ${this.path}${this.cause ? `. Cause: ${causeStr}` : ""}`;
  }
}

/**
 * Line range out of bounds error
 */
export class OutOfBoundsError extends Data.TaggedError("OutOfBoundsError")<{
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly operation: "replace_lines" | "delete_lines";
}> {
  override get message() {
    return `Line range ${this.startLine}-${this.endLine} is out of bounds (file has ${this.totalLines} lines)`;
  }
}

/**
 * Insert position out of bounds error
 */
export class InsertOutOfBoundsError extends Data.TaggedError("InsertOutOfBoundsError")<{
  readonly line: number;
  readonly totalLines: number;
}> {
  override get message() {
    return `Insert position ${this.line} is out of bounds (file has ${this.totalLines} lines)`;
  }
}

/**
 * Pattern not found error - thrown when replace_pattern finds 0 matches
 */
export class PatternNotFoundError extends Data.TaggedError("PatternNotFoundError")<{
  readonly pattern: string;
  readonly expectedCount?: number;
}> {
  override get message() {
    return `Pattern "${this.pattern}" not found in file${this.expectedCount ? ` (expected ${this.expectedCount} match${this.expectedCount === 1 ? "" : "es"})` : ""}`;
  }
}

/**
 * Regex iteration limit exceeded — pattern matched too many times,
 * likely due to a degenerate regex. Thrown instead of silently truncating.
 */
export class RegexIterationLimitError extends Data.TaggedError("RegexIterationLimitError")<{
  readonly pattern: string;
  readonly iterations: number;
}> {
  override get message() {
    return `Regex pattern "${this.pattern}" exceeded ${this.iterations} iterations. Simplify the pattern or use a literal string instead.`;
  }
}

/**
 * File write error
 */
export class FileWriteError extends Data.TaggedError("FileWriteError")<{
  readonly path: string;
  readonly cause?: unknown;
}> {
  override get message() {
    const causeStr =
      this.cause instanceof Error
        ? this.cause.message
        : typeof this.cause === "string"
          ? this.cause
          : typeof this.cause === "object" && this.cause !== null
            ? JSON.stringify(this.cause)
            : String(this.cause);
    return `Failed to write file: ${this.path}${this.cause ? `. Cause: ${causeStr}` : ""}`;
  }
}

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
    pattern: z
      .string()
      .min(1)
      .describe("Literal string or 're:<regex>'. Nested quantifiers like (a+)+ cause an error."),
    replacement: z.string().describe("Replacement text"),
    count: z
      .number()
      .int()
      .optional()
      .refine((v) => v === undefined || v === -1 || v >= 1, {
        message: "count must be a positive integer or -1 (all). Got 0 or invalid negative value.",
      })
      .describe("Matches to replace. Default 1 (first only). Use -1 for all occurrences."),
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
 * Union of all edit file error types.
 * Used for type-safe error matching and discrimination.
 */
export type EditFileError =
  | FileNotFoundError
  | FileReadError
  | OutOfBoundsError
  | InsertOutOfBoundsError
  | PatternNotFoundError
  | RegexIterationLimitError
  | FileWriteError;

/**
 * Maximum number of regex match iterations to prevent infinite loops.
 * Protects against non-global regexes or catastrophic backtracking.
 */
const MAX_REGEX_ITERATIONS = 100_000;

/**
 * Ensure regex has the global flag for multi-match iteration.
 * Without the 'g' flag, `exec()` always starts at index 0, causing an infinite loop.
 */
function ensureGlobalRegex(regex: RegExp): RegExp {
  if (regex.global) return regex;
  return new RegExp(regex.source, regex.flags + "g");
}

/**
 * Apply a sequence of edit operations to file lines.
 * Throws tagged errors for invalid operations (e.g., out-of-bounds, pattern not found).
 *
 * @param lines - The original file lines
 * @param edits - The edit operations to apply
 * @returns Object with resultLines and array of descriptions for each applied edit
 * @throws {OutOfBoundsError} When line range is out of bounds
 * @throws {InsertOutOfBoundsError} When insert position is out of bounds
 * @throws {PatternNotFoundError} When replace_pattern finds 0 matches
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
          throw new OutOfBoundsError({
            startLine: edit.startLine,
            endLine: edit.endLine,
            totalLines: currentLines.length,
            operation: "replace_lines",
          });
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
        // Surface regex rejection as a clear error instead of silently falling back
        if (patternInfo.error) {
          throw new Error(patternInfo.error);
        }
        let content = currentLines.join("\n");
        let replacementCount = 0;
        const maxReplacements = edit.count === -1 ? Infinity : (edit.count ?? 1);

        if (patternInfo.type === "regex" && patternInfo.regex) {
          // Ensure the regex has the global flag to avoid infinite loops
          // when iterating with exec(). Without 'g', exec() always starts
          // at index 0 and lastIndex is never advanced by the engine.
          const regex = ensureGlobalRegex(patternInfo.regex);
          let match;
          let iterations = 0;
          const matches: Array<{ index: number; length: number }> = [];

          while ((match = regex.exec(content)) !== null && replacementCount < maxReplacements) {
            matches.push({ index: match.index, length: match[0].length });
            replacementCount++;
            // Advance past zero-length matches to prevent infinite loops
            if (match[0].length === 0) {
              regex.lastIndex++;
            }
            // Safety limit: throw instead of silently truncating replacements
            if (++iterations > MAX_REGEX_ITERATIONS) {
              throw new RegexIterationLimitError({
                pattern: edit.pattern,
                iterations: MAX_REGEX_ITERATIONS,
              });
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
          // Guard against empty search string — indexOf("", n) always returns n,
          // causing content.length iterations with no progress
          if (searchStr.length === 0) {
            throw new PatternNotFoundError({ pattern: edit.pattern });
          }
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

        // Throw when pattern finds 0 matches — this is a failure the LLM should know about
        if (replacementCount === 0) {
          const expectedCount = edit.count === -1 ? undefined : (edit.count ?? 1);
          throw new PatternNotFoundError(
            expectedCount !== undefined
              ? { pattern: edit.pattern, expectedCount }
              : { pattern: edit.pattern },
          );
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
          throw new InsertOutOfBoundsError({
            line: edit.line,
            totalLines: currentLines.length,
          });
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
          throw new OutOfBoundsError({
            startLine: edit.startLine,
            endLine: edit.endLine,
            totalLines: currentLines.length,
            operation: "delete_lines",
          });
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
 * Extract the tagged error type name from an error instance.
 * Returns a discriminating string the LLM can use for programmatic error handling.
 */
function extractErrorType(error: unknown): string {
  if (error instanceof OutOfBoundsError) return "OutOfBoundsError";
  if (error instanceof InsertOutOfBoundsError) return "InsertOutOfBoundsError";
  if (error instanceof PatternNotFoundError) return "PatternNotFoundError";
  if (error instanceof RegexIterationLimitError) return "RegexIterationLimitError";
  if (error instanceof FileNotFoundError) return "FileNotFoundError";
  if (error instanceof FileReadError) return "FileReadError";
  if (error instanceof FileWriteError) return "FileWriteError";
  return "UnknownError";
}

/**
 * Create edit file tools (approval + execution pair).
 */
export function createEditFileTools(): ApprovalToolPair<EditFileDeps> {
  const config: ApprovalToolConfig<EditFileDeps, EditFileArgs> = {
    name: "edit_file",
    description:
      "Edit file via replace_lines, replace_pattern, insert, or delete_lines. Applied in order. replace_pattern defaults to first match only; use count:-1 for all.",
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

        // Use Effect.catchAll instead of try/catch — yield* propagates Effect
        // failures through the Effect error channel, NOT through JS exceptions.
        const fileContentResult = yield* fs.readFileString(target).pipe(
          Effect.map((content) => ({ ok: true as const, content })),
          Effect.catchAll((error) => Effect.succeed({ ok: false as const, error: String(error) })),
        );

        if (!fileContentResult.ok) {
          return `WARNING: File exists but cannot be read: ${target}. Error: ${fileContentResult.error}`;
        }

        const fileContent = fileContentResult.content;
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
          // applyEdits throws JS exceptions (tagged errors), so try/catch is correct here
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
          const err = new FileNotFoundError({ path: target });
          return {
            success: false,
            result: { errorType: "FileNotFoundError", path: target },
            error: err.message,
          };
        }

        // Read file content — use Effect.catchAll to properly catch Effect failures.
        // A JS try/catch around yield* does NOT catch Effect-level failures.
        const fileContentResult = yield* fs.readFileString(target).pipe(
          Effect.map((content) => ({ ok: true as const, content })),
          Effect.catchAll((error) => Effect.succeed({ ok: false as const, error: String(error) })),
        );

        if (!fileContentResult.ok) {
          const err = new FileReadError({ path: target, cause: fileContentResult.error });
          return {
            success: false,
            result: { errorType: "FileReadError", path: target },
            error: err.message,
          };
        }

        const fileContent = fileContentResult.content;
        const lines = fileContent.split("\n");

        // Apply edits using the shared helper function.
        // applyEdits throws JS exceptions (tagged errors), so try/catch is correct here.
        try {
          const { resultLines, appliedEdits } = applyEdits(lines, args.edits);

          const newContent = resultLines.join("\n");

          // Write file — use Effect.catchAll to properly catch Effect failures
          const writeResult = yield* fs.writeFileString(target, newContent).pipe(
            Effect.map(() => ({ ok: true as const })),
            Effect.catchAll((error) =>
              Effect.succeed({ ok: false as const, error: String(error) }),
            ),
          );

          if (!writeResult.ok) {
            const err = new FileWriteError({ path: target, cause: writeResult.error });
            return {
              success: false,
              result: { errorType: "FileWriteError", path: target },
              error: err.message,
            };
          }

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
          // Extract structured error info from tagged errors so the LLM can
          // programmatically distinguish between error types and take appropriate action
          const errorType = extractErrorType(error);
          return {
            success: false,
            result: { errorType, path: target },
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
  };

  return defineApprovalTool<EditFileDeps, EditFileArgs>(config);
}
