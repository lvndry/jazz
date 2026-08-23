import { FileSystem } from "@effect/platform";
import { Data, Effect } from "effect";
import { z } from "zod";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import type { ToolExecutionContext } from "@/core/types";
import { generateDiff, generateDiffWithMetadata } from "@/core/utils/diff";
import { buildLineOffsets, findAllOccurrenceLineNumbers, offsetToLine } from "@/core/utils/string";
import { FILE_MUTATION_PREVIEW_CHARS } from "@/core/utils/tool-formatter";
import {
  defineApprovalTool,
  makeZodValidator,
  type ApprovalToolConfig,
  type ApprovalToolPair,
} from "../base-tool";
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
 * Invalid pattern error - thrown when normalizeFilterPattern rejects a pattern
 * (e.g., nested quantifiers like (a+)+, malformed regex).
 */
export class InvalidPatternError extends Data.TaggedError("InvalidPatternError")<{
  readonly pattern: string;
  readonly reason: string;
}> {
  override get message() {
    return `Invalid pattern "${this.pattern}": ${this.reason}`;
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
 * Pattern too complex error — thrown when replace_pattern is used for structural
 * edits (multi-line patterns, very long patterns) instead of simple find-and-replace.
 */
export class PatternTooComplexError extends Data.TaggedError("PatternTooComplexError")<{
  readonly pattern: string;
  readonly reason: string;
}> {
  override get message() {
    return `Pattern too complex for replace_pattern: ${this.reason}. Use replace_lines for structural edits instead.`;
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

const editOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("replace_lines"),
      startLine: z
        .number()
        .int()
        .positive()
        .describe("First line to replace, 1-based and inclusive. Use the numbers from read_file."),
      endLine: z.number().int().positive().describe("Last line to replace, 1-based and inclusive."),
      content: z
        .string()
        .describe(
          "Text that replaces the startLine–endLine range. Do not include the `N|` prefix from read_file.",
        ),
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
        "Text to find. A plain string matches literally. Prefix with re: for a regex. Use this for a short single-line swap (rename a variable, change quotes). For multi-line or structural edits, use replace_lines. Nested quantifiers such as (a+)+ are rejected.",
      ),
    replacement: z
      .string()
      .describe(
        "Text to put in place of each match. Literal text — $1 and similar are not expanded.",
      ),
    count: z
      .number()
      .int()
      .optional()
      .refine((v) => v === undefined || v === -1 || v >= 1, {
        message: "count must be a positive integer or -1 (all). Got 0 or invalid negative value.",
      })
      .describe(
        "How many matches to replace. Default 1 (the first match only). Pass -1 to replace every match.",
      ),
  }),
  z.object({
    type: z.literal("insert"),
    line: z
      .number()
      .int()
      .nonnegative()
      .describe("Insert after this line. 0 means before the first line. 5 means after line 5."),
    content: z.string().describe("Text to insert. Do not include the `N|` prefix from read_file."),
  }),
  z
    .object({
      type: z.literal("delete_lines"),
      startLine: z
        .number()
        .int()
        .positive()
        .describe("First line to delete, 1-based and inclusive."),
      endLine: z.number().int().positive().describe("Last line to delete, 1-based and inclusive."),
    })
    .refine((data) => data.startLine <= data.endLine, {
      message: "startLine must be less than or equal to endLine",
    }),
]);

const editFileParameters = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        "File to edit. Absolute or relative to the session working directory. The file must already exist.",
      ),
    edits: z
      .array(editOperationSchema)
      .min(1)
      .describe(
        "One or more edits, applied in the order given: replace_lines, replace_pattern, insert, or delete_lines. After each edit, later line numbers refer to the file as it now is.",
      ),
  })
  .strict();

export type EditOperation = z.infer<typeof editOperationSchema>;
export type EditFileArgs = z.infer<typeof editFileParameters>;

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
  | InvalidPatternError
  | RegexIterationLimitError
  | PatternTooComplexError
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
 * @throws {InvalidPatternError} When pattern is malformed (e.g., nested quantifiers)
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
        // Reject patterns that suggest structural edits — these should use replace_lines
        if (edit.pattern.includes("\n") || edit.pattern.includes("\\n")) {
          throw new PatternTooComplexError({
            pattern: edit.pattern,
            reason: "Pattern contains newlines — this is a structural edit",
          });
        }
        if (edit.pattern.length > 200) {
          throw new PatternTooComplexError({
            pattern: edit.pattern.slice(0, 50) + "...",
            reason: `Pattern is ${edit.pattern.length} characters long — too long for find-and-replace`,
          });
        }
        // Reject multi-line regex wildcards (e.g., [\s\S]*, .* with s flag) that match across lines
        const multiLineRegexIndicators = /\[\\s\\S\]|\[\\S\\s\]|\(\?s\)|\\n/;
        if (multiLineRegexIndicators.test(edit.pattern)) {
          throw new PatternTooComplexError({
            pattern: edit.pattern,
            reason: "Pattern uses multi-line matching — this is a structural edit",
          });
        }

        const patternInfo = normalizeFilterPattern(edit.pattern);
        // Surface regex rejection as a clear error instead of silently falling back
        if (patternInfo.error) {
          throw new InvalidPatternError({ pattern: edit.pattern, reason: patternInfo.error });
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
  if (error instanceof InvalidPatternError) return "InvalidPatternError";
  if (error instanceof RegexIterationLimitError) return "RegexIterationLimitError";
  if (error instanceof PatternTooComplexError) return "PatternTooComplexError";
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
      "Change part of a file that already exists. To create a new file, use write_file. You can pass several edits in one call; they run one after another. If an earlier edit inserts or deletes lines, later edits must use the line numbers of the file as it is after those edits — not the numbers from the original read_file. " +
      "Use this whenever you are changing an existing file. Do not use this to create a file (write_file), to rewrite the whole file after a failed edit (read the errorType and retry), or to run sed via execute_command. " +
      "Prefer replace_pattern with a unique literal substring. Omit count to replace the first match only; pass count: -1 to replace all. Use replace_lines, insert, or delete_lines when you have exact 1-based line numbers from read_file. The `N|` prefix on those lines is metadata — do not copy it into content. " +
      "insert.line: 0 puts text before line 1; N puts text after line N. replace_pattern accepts a short single-line literal or a re:<regex>. The replacement is literal text, not a regex substitution — $1 is not expanded.",
    tags: ["filesystem", "write", "edit"],
    parameters: editFileParameters,
    validate: makeZodValidator(editFileParameters),

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
            case "replace_pattern": {
              // Find affected line numbers for a clearer approval message.
              // Build a newline offset index once (O(N) over file size), then
              // binary-search it per match (O(log N) per match) instead of
              // slicing + splitting inside the loop (O(N²)).
              const patternInfo = normalizeFilterPattern(edit.pattern);
              const content = lines.join("\n");
              const matchLineNumbers: number[] = [];

              if (patternInfo.type === "regex" && patternInfo.regex && !patternInfo.error) {
                const lineOffsets = buildLineOffsets(content);
                const regex = ensureGlobalRegex(patternInfo.regex);
                let match;
                while ((match = regex.exec(content)) !== null && matchLineNumbers.length < 20) {
                  matchLineNumbers.push(offsetToLine(lineOffsets, match.index));
                  if (match[0].length === 0) regex.lastIndex++;
                }
              } else if (!patternInfo.error) {
                const searchStr = patternInfo.value || edit.pattern;
                matchLineNumbers.push(...findAllOccurrenceLineNumbers(content, searchStr, 20));
              }

              const countDesc = edit.count === -1 ? "all" : (edit.count ?? 1);
              const linesDesc =
                matchLineNumbers.length > 0
                  ? ` on line${matchLineNumbers.length === 1 ? "" : "s"} ${matchLineNumbers.join(", ")}${matchLineNumbers.length >= 20 ? "..." : ""}`
                  : "";
              return `  ${idx + 1}. Replace "${edit.pattern}" with "${edit.replacement}" (${countDesc} occurrence${countDesc === 1 ? "" : "s"}${linesDesc})`;
            }
            case "insert":
              return `  ${idx + 1}. Insert content after line ${edit.line} (${edit.content.split("\n").length} lines)`;
            case "delete_lines":
              return `  ${idx + 1}. Delete lines ${edit.startLine}-${edit.endLine}`;
          }
        });

        // Simulate edits — if they fail, skip approval and return error directly to the LLM
        let resultLines: string[];

        try {
          const result = applyEdits(lines, args.edits);
          resultLines = result.resultLines;
        } catch (error) {
          // applyEdits throws JS exceptions (tagged errors), so try/catch is correct here
          const errorType = extractErrorType(error);
          const errorMessage = error instanceof Error ? error.message : "Error simulating edit";
          return {
            skipApproval: true,
            toolResult: {
              success: false,
              result: { errorType, path: target },
              error: errorMessage,
            },
          };
        }

        // This message is shown to whoever approves the edit, which is not always a person
        // at a terminal: it also goes into the `jazz run --json` envelope and out to chat
        // bridges like Telegram. Keep it to what is about to happen. Do not append keyboard
        // hints such as "Press Ctrl+O to preview" — most approvers have no keyboard, and
        // the TUI already renders its own hint from `previewDiff` below.
        const message = `About to edit file: ${target} (${totalLines} lines total)\n\nEdits to perform:\n${editDescriptions.join("\n")}`;

        // Generate full diff for Ctrl+O expansion
        const newContent = resultLines.join("\n");
        const { diff } = generateDiffWithMetadata(fileContent, newContent, target, {
          maxLines: Number.POSITIVE_INFINITY,
        });
        return { message, previewDiff: diff };
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
          const needsExpansion =
            wasTruncated ||
            newContent.length > FILE_MUTATION_PREVIEW_CHARS ||
            diff.length > FILE_MUTATION_PREVIEW_CHARS;
          const fullDiff = needsExpansion
            ? generateDiff(fileContent, newContent, target, {
                maxLines: Number.POSITIVE_INFINITY,
                fullPatch: true,
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
