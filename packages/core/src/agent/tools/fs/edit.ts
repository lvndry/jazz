import { FileSystem } from "@effect/platform";
import { Data, Effect } from "effect";
import { z } from "zod";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import { redactLines } from "@/core/secrets/redacted-lines";
import { redactedWriteProblem, type KnownSecret } from "@/core/secrets/redaction";
import type { ToolExecutionContext } from "@/core/types";
import { generateDiff, generateDiffWithMetadata } from "@/core/utils/diff";
import { toError } from "@/core/utils/errors";
import { jazzStateApprovalNotice, jazzStateChangeReason } from "@/core/utils/jazz-state-paths";
import { withLock } from "@/core/utils/storage";
import { buildLineOffsets, findAllOccurrenceLineNumbers, offsetToLine } from "@/core/utils/string";
import { FILE_MUTATION_PREVIEW_CHARS } from "@/core/utils/tool-formatter";
import {
  defineApprovalTool,
  makeZodValidator,
  type ApprovalToolConfig,
  type ApprovalToolPair,
} from "../base-tool";
import { buildKeyFromContext } from "../context-utils";
import { toolKnownSecrets } from "../tool-secrets";
import { writeFileAtomically } from "./atomic-replace";
import { fileSnapshot } from "./file-snapshot";
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
 * Secret line match error — a replace_pattern match touches a line holding a secret value, which
 * the model sees only as a `[redacted:<name>]` placeholder.
 */
export class SecretLineMatchError extends Data.TaggedError("SecretLineMatchError")<{
  readonly pattern: string;
  readonly line: number;
}> {
  override get message() {
    return `Pattern "${this.pattern}" matches line ${this.line}, which holds a secret value shown as a [redacted:…] placeholder. Use a pattern from the lines around it, or replace_lines or delete_lines for that line.`;
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
      startLine: z.number().int().positive().describe("First line, 1-based, inclusive."),
      endLine: z.number().int().positive().describe("Last line, inclusive."),
      content: z.string().describe("Replacement text."),
    })
    .refine((data) => data.startLine <= data.endLine, {
      message: "startLine must be less than or equal to endLine",
    }),
  z.object({
    type: z.literal("replace_pattern"),
    pattern: z.string().min(1).describe("Literal single-line text, or re:<regex>."),
    replacement: z.string().describe("Literal text; $1 is not expanded."),
    count: z
      .number()
      .int()
      .optional()
      .refine((v) => v === undefined || v === -1 || v >= 1, {
        message: "count must be a positive integer or -1 (all). Got 0 or invalid negative value.",
      })
      .describe("Matches to replace: omit for the first, -1 for all."),
  }),
  z.object({
    type: z.literal("insert"),
    line: z
      .number()
      .int()
      .nonnegative()
      .describe("Insert after this line; 0 inserts before line 1."),
    content: z.string().describe("Text to insert."),
  }),
  z
    .object({
      type: z.literal("delete_lines"),
      startLine: z.number().int().positive().describe("First line, 1-based, inclusive."),
      endLine: z.number().int().positive().describe("Last line, inclusive."),
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
      .describe("Existing file, absolute or relative to the working directory."),
    snapshot: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .describe("Snapshot from your latest read_file of this file."),
    edits: z
      .array(editOperationSchema)
      .min(1)
      .describe(
        "Applied in order; each edit's line numbers refer to the file after the previous edits.",
      ),
  })
  .strict();

export type EditOperation = z.infer<typeof editOperationSchema>;

/** Why an edit would write a redaction placeholder over a secret, or undefined when none would. */
function redactedEditProblem(
  edits: readonly EditOperation[],
  currentContent: string,
  known: readonly KnownSecret[],
): string | undefined {
  for (const [index, edit] of edits.entries()) {
    const fields: ReadonlyArray<readonly [string, string]> =
      edit.type === "replace_pattern"
        ? [["replacement", edit.replacement]]
        : edit.type === "delete_lines"
          ? []
          : [["content", edit.content]];
    for (const [field, text] of fields) {
      const problem = redactedWriteProblem({
        tool: "edit_file",
        field: `edits[${String(index)}].${field}`,
        text,
        currentContent,
        known,
      });
      if (problem !== undefined) {
        return problem;
      }
    }
  }
  return undefined;
}
export type EditFileArgs = z.infer<typeof editFileParameters>;

type EditFileDeps = FileSystem.FileSystem | FileSystemContextService;

/** A stale read is recoverable by reading the file again, without asking for approval. */
function staleFileResult(path: string) {
  return {
    success: false,
    result: { errorType: "StaleFileError", path },
    error: `File changed since read_file: ${path}. Read the file again, inspect the current lines, and retry edit_file with its new snapshot. No edit was applied.`,
  } as const;
}

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
  | SecretLineMatchError
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
 * The file's lines alongside their redacted view, carried through a sequence of edits. `masked`
 * shows each line as the model sees it (secret lines as placeholders); `secret` flags those lines.
 */
interface EditableLines {
  readonly raw: string[];
  readonly masked: string[];
  readonly secret: boolean[];
}

/** `lines` with no secret, where the redacted view is the text itself. */
function plainLines(lines: readonly string[]): EditableLines {
  return { raw: [...lines], masked: [...lines], secret: lines.map(() => false) };
}

/** The lines of `content`, split on `\n`, with the lines holding a secret masked. */
function editableLines(content: string, known: readonly KnownSecret[]): EditableLines {
  const raw = content.split("\n");
  const view = redactLines(raw, known);
  return {
    raw,
    masked: [...view.lines],
    secret: raw.map((_line, index) => view.secretLineIndexes.has(index)),
  };
}

function spliceLines(
  current: EditableLines,
  start: number,
  deleteCount: number,
  inserted: readonly string[],
): EditableLines {
  return {
    raw: [...current.raw.slice(0, start), ...inserted, ...current.raw.slice(start + deleteCount)],
    masked: [
      ...current.masked.slice(0, start),
      ...inserted,
      ...current.masked.slice(start + deleteCount),
    ],
    secret: [
      ...current.secret.slice(0, start),
      ...inserted.map(() => false),
      ...current.secret.slice(start + deleteCount),
    ],
  };
}

/** Where `pattern` matches `content`, left to right and without overlap, up to `maxMatches`. */
function findPatternMatches(
  content: string,
  edit: Extract<EditOperation, { type: "replace_pattern" }>,
  maxMatches: number,
): Array<{ index: number; length: number }> {
  const patternInfo = normalizeFilterPattern(edit.pattern);
  // Surface regex rejection as a clear error instead of silently falling back
  if (patternInfo.error) {
    throw new InvalidPatternError({ pattern: edit.pattern, reason: patternInfo.error });
  }
  const matches: Array<{ index: number; length: number }> = [];
  if (patternInfo.type === "regex" && patternInfo.regex) {
    // Without the global flag, exec() always starts at index 0 and never advances.
    const regex = ensureGlobalRegex(patternInfo.regex);
    let match;
    let iterations = 0;
    while (matches.length < maxMatches && (match = regex.exec(content)) !== null) {
      matches.push({ index: match.index, length: match[0].length });
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
    return matches;
  }
  const searchStr = patternInfo.value || edit.pattern;
  // indexOf("", n) always returns n, which would never advance.
  if (searchStr.length === 0) {
    throw new PatternNotFoundError({ pattern: edit.pattern });
  }
  let searchIndex = 0;
  while (
    matches.length < maxMatches &&
    (searchIndex = content.indexOf(searchStr, searchIndex)) !== -1
  ) {
    matches.push({ index: searchIndex, length: searchStr.length });
    searchIndex += searchStr.length;
  }
  return matches;
}

/**
 * Replace `pattern` in the redacted view, so that whether and where it matches never depends on
 * a secret value. A match touching a secret line is refused; every other line reads the same in
 * both views, so the secret lines are carried over whole from the original.
 */
function replacePattern(
  current: EditableLines,
  edit: Extract<EditOperation, { type: "replace_pattern" }>,
): { lines: EditableLines; replacementCount: number } {
  const maxReplacements = edit.count === -1 ? Infinity : (edit.count ?? 1);
  const maskedContent = current.masked.join("\n");
  const matches = findPatternMatches(maskedContent, edit, maxReplacements);

  // Throw when pattern finds 0 matches — this is a failure the LLM should know about
  if (matches.length === 0) {
    const expectedCount = edit.count === -1 ? undefined : (edit.count ?? 1);
    throw new PatternNotFoundError(
      expectedCount !== undefined
        ? { pattern: edit.pattern, expectedCount }
        : { pattern: edit.pattern },
    );
  }

  const lineOffsets = buildLineOffsets(maskedContent);
  for (const match of matches) {
    const end = match.index + match.length;
    const firstLine = offsetToLine(lineOffsets, match.index);
    const consumesNewline = match.length > 0 && maskedContent[end - 1] === "\n";
    const lastLine =
      offsetToLine(lineOffsets, Math.max(match.index, end - 1)) + (consumesNewline ? 1 : 0);
    for (let line = firstLine; line <= lastLine; line++) {
      if (current.secret[line - 1] === true) {
        throw new SecretLineMatchError({ pattern: edit.pattern, line });
      }
    }
  }

  let replaced = maskedContent;
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index];
    if (match) {
      replaced =
        replaced.slice(0, match.index) +
        edit.replacement +
        replaced.slice(match.index + match.length);
    }
  }

  const masked = replaced.split("\n");
  const raw = [...masked];
  const secret = masked.map(() => false);
  const newLineOffsets = buildLineOffsets(replaced);
  const lineAtOffset = new Map(newLineOffsets.map((offset, line) => [offset, line]));
  for (const [line, isSecret] of current.secret.entries()) {
    if (!isSecret) {
      continue;
    }
    const oldOffset = lineOffsets[line] ?? 0;
    const shift = matches
      .filter((match) => match.index < oldOffset)
      .reduce((total, match) => total + edit.replacement.length - match.length, 0);
    const newLine = lineAtOffset.get(oldOffset + shift);
    if (newLine !== undefined) {
      raw[newLine] = current.raw[line] ?? "";
      secret[newLine] = true;
    }
  }
  return { lines: { raw, masked, secret }, replacementCount: matches.length };
}

/**
 * Apply a sequence of edit operations to file lines.
 * Throws tagged errors for invalid operations (e.g., out-of-bounds, pattern not found).
 *
 * @param lines - The original file lines, or the file's lines with their redacted view
 * @param edits - The edit operations to apply
 * @returns Object with resultLines and array of descriptions for each applied edit
 * @throws {OutOfBoundsError} When line range is out of bounds
 * @throws {InsertOutOfBoundsError} When insert position is out of bounds
 * @throws {PatternNotFoundError} When replace_pattern finds 0 matches
 * @throws {InvalidPatternError} When pattern is malformed (e.g., nested quantifiers)
 * @throws {SecretLineMatchError} When replace_pattern matches a line holding a secret
 */
function applyEdits(
  lines: readonly string[] | EditableLines,
  edits: readonly EditOperation[],
): { resultLines: string[]; appliedEdits: ApplyEditResult[] } {
  let current = isEditableLines(lines) ? lines : plainLines(lines);
  const appliedEdits: ApplyEditResult[] = [];

  for (const edit of edits) {
    switch (edit.type) {
      case "replace_lines": {
        const startIdx = edit.startLine - 1;
        const endIdx = edit.endLine - 1;

        if (startIdx < 0 || endIdx >= current.raw.length) {
          throw new OutOfBoundsError({
            startLine: edit.startLine,
            endLine: edit.endLine,
            totalLines: current.raw.length,
            operation: "replace_lines",
          });
        }

        const newContentLines = edit.content.split("\n");
        current = spliceLines(current, startIdx, endIdx - startIdx + 1, newContentLines);
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

        const replaced = replacePattern(current, edit);
        current = replaced.lines;
        appliedEdits.push({
          description: `Replaced pattern "${edit.pattern}" ${replaced.replacementCount} time(s) with "${edit.replacement}"`,
        });
        break;
      }

      case "insert": {
        const insertIdx = edit.line;
        const newContentLines = edit.content.split("\n");

        if (insertIdx < 0 || insertIdx > current.raw.length) {
          throw new InsertOutOfBoundsError({
            line: edit.line,
            totalLines: current.raw.length,
          });
        }

        current = spliceLines(current, insertIdx, 0, newContentLines);
        appliedEdits.push({
          description: `Inserted ${newContentLines.length} line(s) after line ${edit.line}`,
        });
        break;
      }

      case "delete_lines": {
        const startIdx = edit.startLine - 1;
        const endIdx = edit.endLine - 1;

        if (startIdx < 0 || endIdx >= current.raw.length) {
          throw new OutOfBoundsError({
            startLine: edit.startLine,
            endLine: edit.endLine,
            totalLines: current.raw.length,
            operation: "delete_lines",
          });
        }

        const deletedCount = endIdx - startIdx + 1;
        current = spliceLines(current, startIdx, deletedCount, []);
        appliedEdits.push({
          description: `Deleted lines ${edit.startLine}-${edit.endLine} (${deletedCount} line(s))`,
        });
        break;
      }
    }
  }

  return { resultLines: current.raw, appliedEdits };
}

function isEditableLines(lines: readonly string[] | EditableLines): lines is EditableLines {
  return !Array.isArray(lines);
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
  if (error instanceof SecretLineMatchError) return "SecretLineMatchError";
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
    disclosure: "private",
    description:
      "Change part of an existing file; to create one, use write_file. Call read_file first and pass its snapshot; if the file changed, read it again. Use replace_pattern with a unique substring for small changes and line-based edits for multi-line ones. Copy only the text after read_file's `N|` prefix into content. Keep lines showing `[redacted:<name>]` out of patterns and content; edit the lines around them. After a failed edit, read errorType, fix the edit and retry.",
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
        const canonicalTargetResult = yield* fs.realPath(target).pipe(Effect.either);
        if (canonicalTargetResult._tag === "Left") {
          const err = new FileNotFoundError({ path: target });
          return {
            skipApproval: true,
            toolResult: {
              success: false,
              result: { errorType: "FileNotFoundError", path: target },
              error: err.message,
            },
          };
        }
        const canonicalTarget = canonicalTargetResult.right;
        const fileContentResult = yield* fs.readFileString(canonicalTarget).pipe(
          Effect.map((content) => ({ ok: true as const, content })),
          Effect.catchAll((error) => Effect.succeed({ ok: false as const, error: String(error) })),
        );

        if (!fileContentResult.ok) {
          return `WARNING: File exists but cannot be read: ${target}. Error: ${fileContentResult.error}`;
        }

        const fileContent = fileContentResult.content;
        if (fileSnapshot(canonicalTarget, fileContent) !== args.snapshot) {
          return { skipApproval: true, toolResult: staleFileResult(target) };
        }
        const known = yield* toolKnownSecrets();
        const redactedEdit = redactedEditProblem(args.edits, fileContent, known);
        if (redactedEdit !== undefined) {
          return yield* Effect.fail(new Error(redactedEdit));
        }
        const editable = editableLines(fileContent, known);
        const lines = editable.masked;
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
          const result = applyEdits(editable, args.edits);
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
        const stateReason = jazzStateChangeReason(target);
        const message = [
          `About to edit file: ${target} (${totalLines} lines total)`,
          `Edits to perform:\n${editDescriptions.join("\n")}`,
          ...(stateReason !== undefined ? [jazzStateApprovalNotice(stateReason)] : []),
        ].join("\n\n");

        // Generate full diff for Ctrl+O expansion
        const newContent = resultLines.join("\n");
        const { diff } = generateDiffWithMetadata(fileContent, newContent, target, {
          maxLines: Number.POSITIVE_INFINITY,
        });
        return {
          message,
          previewDiff: diff,
          ...(stateReason !== undefined ? { alwaysAsk: true as const } : {}),
        };
      }),

    handler: (args: EditFileArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path);
        const canonicalTargetResult = yield* fs.realPath(target).pipe(Effect.either);
        if (canonicalTargetResult._tag === "Left") {
          const err = new FileNotFoundError({ path: target });
          return {
            success: false,
            result: { errorType: "FileNotFoundError", path: target },
            error: err.message,
          };
        }
        const canonicalTarget = canonicalTargetResult.right;

        // The lock serializes Jazz edit_file calls from separate agents and processes.
        // Keep validation and mutation inside it; a lock around only the write still loses edits.
        return yield* withLock(
          `${canonicalTarget}.jazz-edit.lock`,
          Effect.gen(function* () {
            const fileExists = yield* fs
              .exists(canonicalTarget)
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
            const fileContentResult = yield* fs.readFileString(canonicalTarget).pipe(
              Effect.map((content) => ({ ok: true as const, content })),
              Effect.catchAll((error) =>
                Effect.succeed({ ok: false as const, error: String(error) }),
              ),
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
            if (fileSnapshot(canonicalTarget, fileContent) !== args.snapshot) {
              return staleFileResult(target);
            }
            const known = yield* toolKnownSecrets();
            const redactedEdit = redactedEditProblem(args.edits, fileContent, known);
            if (redactedEdit !== undefined) {
              return yield* Effect.fail(new Error(redactedEdit));
            }
            const editable = editableLines(fileContent, known);
            const lines = editable.raw;

            // Apply edits using the shared helper function.
            // applyEdits throws JS exceptions (tagged errors), so try/catch is correct here.
            try {
              const { resultLines, appliedEdits } = applyEdits(editable, args.edits);

              const newContent = resultLines.join("\n");

              // Old content or new, never a truncated file, however the call is stopped.
              const writeResult = yield* writeFileAtomically(fs, canonicalTarget, newContent).pipe(
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

              const { diff, wasTruncated } = generateDiffWithMetadata(
                fileContent,
                newContent,
                target,
              );
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
                error: toError(error).message,
              };
            }
          }),
        );
      }),
  };

  return defineApprovalTool<EditFileDeps, EditFileArgs>(config);
}
