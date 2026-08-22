import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import type { FileSystemContextService } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool, makeZodValidator } from "../base-tool";
import { attachMediaFile } from "./attach-media";
import { resolveReadableFile, stripUtf8Bom } from "./read-common";

const DEFAULT_MAX_CHARS = 131_072;
const HARD_MAX_CHARS = 524_288;

const lineIndexSchema = z
  .number()
  .int()
  .refine((value) => value !== 0, {
    message: "Line numbers are 1-based; use negative values to count from the end. 0 is invalid.",
  });

/**
 * Number lines the way coding models expect: `   12|content`.
 * `startLine` is the 1-based file line of `lines[0]`.
 */
export function formatNumberedContent(lines: readonly string[], startLine: number): string {
  if (lines.length === 0) return "";
  const lastLine = startLine + lines.length - 1;
  const width = String(Math.max(lastLine, 1)).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width)}|${line}`)
    .join("\n");
}

/**
 * Resolve optional 1-based / negative-from-end line bounds against `totalLines`.
 * Negative N means "Nth line from the end" (`-1` is the last line).
 */
export function resolveLineRange(
  startLine: number | undefined,
  endLine: number | undefined,
  totalLines: number,
): { startLine: number; endLine: number } {
  if (totalLines <= 0) {
    return { startLine: 1, endLine: 0 };
  }

  function resolve(value: number | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    if (value > 0) return Math.min(value, totalLines);
    return Math.max(1, totalLines + value + 1);
  }

  const start = resolve(startLine, 1);
  const end = resolve(endLine, totalLines);
  if (start <= end) {
    return { startLine: start, endLine: end };
  }
  return { startLine: start, endLine: start };
}

function trimToMaxChars(
  lines: readonly string[],
  maxChars: number,
): { lines: string[]; truncated: boolean } {
  const joined = lines.join("\n");
  if (joined.length <= maxChars) {
    return { lines: [...lines], truncated: false };
  }
  if (lines.length === 0) {
    return { lines: [], truncated: false };
  }

  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const extra = kept.length === 0 ? line.length : line.length + 1;
    if (used + extra > maxChars) {
      if (kept.length === 0) {
        return { lines: [line.slice(0, maxChars)], truncated: true };
      }
      return { lines: kept, truncated: true };
    }
    kept.push(line);
    used += extra;
  }
  return { lines: kept, truncated: true };
}

export function createReadFileTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .min(1)
        .describe(
          "File to read. Absolute or relative to the session working directory. Must be a file, not a directory.",
        ),
      startLine: lineIndexSchema
        .optional()
        .describe(
          "First line to return, 1-based and inclusive. Negative counts from the end: -1 is the last line, -20 starts 20 lines from the end. Omit startLine and endLine to read from the top, up to maxBytes.",
        ),
      endLine: lineIndexSchema
        .optional()
        .describe(
          "Last line to return, 1-based and inclusive. Negative counts from the end. Omit to read through the last line, or until maxBytes is reached.",
        ),
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Maximum number of characters to return after applying the line range. Measured as JavaScript string length, not UTF-8 bytes, despite the parameter name. Default 131072, hard cap 524288.",
        ),
    })
    .strict();

  type ReadFileParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, ReadFileParams>({
    name: "read_file",
    description:
      "Read a file relative to the session working directory. UTF-8 text is returned as numbered lines (`   12|content`) so edit_file can use those numbers for replace_lines, insert, and delete_lines. " +
      "Images, PDFs, audio, and video are attached to the conversation when the active model supports that modality. " +
      "Use this to inspect or edit text and code. Do not use this for directories (ls), to discover filenames (find), for unsupported binary formats, or via execute_command with cat/sed/nl. " +
      "For large files, pass startLine and endLine. A negative startLine reads from the end (startLine: -20 is the last 20 lines). " +
      "Do not copy the `N|` prefix into edit_file or write_file — it is line-number metadata. " +
      "If truncated is true, read the next range; do not assume you saw the whole file. UTF-8 only; a leading BOM is stripped.",
    tags: ["filesystem", "read"],
    parameters,
    validate: makeZodValidator(parameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const resolved = yield* resolveReadableFile(args.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const filePathResult = resolved.path;
        const fs = yield* FileSystem.FileSystem;

        // Images, PDFs, audio and video are not text. Reading their bytes as UTF-8 produces
        // mojibake that costs thousands of tokens and tells the model nothing, so they are
        // attached to the turn instead and delivered to the model as file parts.
        const mediaOutcome = yield* Effect.promise(() => attachMediaFile(filePathResult, context));
        if (mediaOutcome.kind !== "not-media") return mediaOutcome.result;

        try {
          const raw = stripUtf8Bom(yield* fs.readFileString(filePathResult));
          const allLines = raw === "" ? [] : raw.split(/\r?\n/);
          const totalLines = allLines.length;
          const hasRange = args.startLine !== undefined || args.endLine !== undefined;
          const range = hasRange
            ? resolveLineRange(args.startLine, args.endLine, totalLines)
            : { startLine: 1, endLine: totalLines };

          const selected =
            totalLines === 0 ? [] : allLines.slice(range.startLine - 1, range.endLine);

          const requestedMaxChars =
            typeof args.maxBytes === "number" && args.maxBytes > 0
              ? args.maxBytes
              : DEFAULT_MAX_CHARS;
          const maxChars = Math.min(requestedMaxChars, HARD_MAX_CHARS);
          const trimmed = trimToMaxChars(selected, maxChars);
          const returnedLines = trimmed.lines.length;
          const rangeEnd =
            returnedLines === 0 ? range.startLine - 1 : range.startLine + returnedLines - 1;

          return {
            success: true,
            result: {
              path: filePathResult,
              content: formatNumberedContent(trimmed.lines, range.startLine),
              truncated: trimmed.truncated,
              totalLines,
              returnedLines,
              range:
                totalLines === 0
                  ? undefined
                  : { startLine: range.startLine, endLine: Math.max(range.startLine, rangeEnd) },
            },
          };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `readFile failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}
