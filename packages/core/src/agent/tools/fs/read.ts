/**
 * The `read` tool: returns file contents numbered for coding-model consumption,
 * with an optional line range (negative values count from the end of the file)
 * and a hard character cap to avoid flooding the context window.
 *
 * `sinceByte` is the incremental mode for a file still being written: read only what was
 * appended, hand back the `nextByte` and `inode` to distinguish an append from a rotation.
 */

import { open, stat } from "node:fs/promises";
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

/** What a `sinceByte` read found, before line numbering and capping are applied. */
interface IncrementalRead {
  readonly text: string;
  /** Byte offset where `text` begins in the current file. */
  readonly startByte: number;
  readonly nextByte: number;
  readonly fileSize: number;
  readonly inode: number;
  /** Set when `sinceByte` was ignored and the read restarted at 0, with the reason why. */
  readonly reset?: "rotated" | "truncated";
}

/**
 * Read the bytes appended after `sinceByte`, restarting at 0 when the offset went stale.
 *
 * Rotation needs the inode, not the size: a renamed-away log's replacement is often *longer* than
 * the old offset, so a size check sees a valid offset into unrelated content. Truncation in place
 * keeps the inode and drops below the offset.
 */
async function readSince(
  filePath: string,
  sinceByte: number,
  sinceInode: number | undefined,
): Promise<IncrementalRead> {
  const stats = await stat(filePath);
  const inode = Number(stats.ino);
  const fileSize = stats.size;

  const rotated = sinceInode !== undefined && sinceInode !== inode;
  const truncated = fileSize < sinceByte;
  const start = rotated || truncated ? 0 : sinceByte;

  const handle = await open(filePath, "r");
  try {
    const length = Math.max(0, fileSize - start);
    if (length === 0) {
      return {
        text: "",
        startByte: start,
        nextByte: fileSize,
        fileSize,
        inode,
        ...(rotated
          ? { reset: "rotated" as const }
          : truncated
            ? { reset: "truncated" as const }
            : {}),
      };
    }
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      startByte: start,
      nextByte: start + bytesRead,
      fileSize,
      inode,
      ...(rotated
        ? { reset: "rotated" as const }
        : truncated
          ? { reset: "truncated" as const }
          : {}),
    };
  } finally {
    await handle.close();
  }
}

/**
 * The byte cursor immediately after the source represented by a capped incremental response.
 *
 * `trimToMaxChars` deliberately returns whole lines where it can, so the next reader must pass
 * the line ending too; otherwise it gets an artificial empty line before the first unseen one.
 * When a single line is longer than the cap, it instead returns a character prefix of that line.
 * Calculating the offset from the original text preserves CRLF and UTF-8 byte widths, which the
 * normalized rendered response does not retain.
 */
function nextByteAfterCappedText(
  incremental: IncrementalRead,
  returnedLines: readonly string[],
): number {
  let sourceIndex = 0;
  for (const returned of returnedLines) {
    const newline = incremental.text.indexOf("\n", sourceIndex);
    const contentEnd =
      newline === -1
        ? incremental.text.length
        : newline > sourceIndex && incremental.text[newline - 1] === "\r"
          ? newline - 1
          : newline;
    const sourceLine = incremental.text.slice(sourceIndex, contentEnd);

    if (returned.length < sourceLine.length) {
      return (
        incremental.startByte +
        Buffer.byteLength(incremental.text.slice(0, sourceIndex + returned.length))
      );
    }

    sourceIndex = newline === -1 ? incremental.text.length : newline + 1;
  }
  return incremental.startByte + Buffer.byteLength(incremental.text.slice(0, sourceIndex));
}

/**
 * Whether this call is a genuine incremental follow-read.
 *
 * `sinceByte: 0` means "from the start of the file", which is what an ordinary read already
 * does — so on its own it contradicts nothing, and a line range alongside it simply narrows
 * the result. Models that fill every optional number in the schema with 0 send exactly that
 * shape, and refusing them for a conflict they did not intend costs a round trip that teaches
 * nothing. Only a *positive* `sinceByte` genuinely conflicts with a line range, and the schema
 * refuses that outright.
 *
 * `sinceByte: 0` with no line range stays incremental, so a caller can legitimately start
 * following a file from its very beginning and still get `nextByte` and `inode` back.
 */
export function isIncrementalRead(args: {
  readonly sinceByte?: number | undefined;
  readonly startLine?: number | undefined;
  readonly endLine?: number | undefined;
}): boolean {
  if (args.sinceByte === undefined) return false;
  if (args.sinceByte > 0) return true;
  return args.startLine === undefined && args.endLine === undefined;
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
      sinceByte: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Returns only what was appended past this byte offset, for following a file still being written. Pass the previous read's nextByte. Omit for ordinary reads; not combinable with startLine/endLine.",
        ),
      sinceInode: z
        .number()
        .int()
        .optional()
        .describe(
          "The previous read's inode, so a rotated file is detected instead of read as an append. Only with sinceByte; omit otherwise.",
        ),
    })
    .strict()
    .refine(
      (value) =>
        value.sinceByte === undefined ||
        value.sinceByte === 0 ||
        (value.startLine === undefined && value.endLine === undefined),
      {
        message:
          "sinceByte reads by byte offset while startLine and endLine read by line number. Drop sinceByte to read the line range, or drop startLine and endLine to follow the file from that offset.",
      },
    )
    .refine((value) => value.sinceInode === undefined || value.sinceByte !== undefined, {
      message:
        "sinceInode only means something alongside sinceByte. Drop sinceInode, or pass sinceByte from your previous read's nextByte.",
    });

  type ReadFileParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, ReadFileParams>({
    name: "read_file",
    disclosure: "private",
    description:
      "Read a file relative to the session working directory. UTF-8 text is returned as numbered lines (`   12|content`) so edit_file can use those numbers for replace_lines, insert, and delete_lines. " +
      "Images, PDFs, audio, and video are attached to the conversation when the active model supports that modality. " +
      "Use this to inspect or edit text and code. Do not use this for directories (ls), to discover filenames (find), for unsupported binary formats, or via execute_command with cat/sed/nl. " +
      "For large files, pass startLine and endLine. A negative startLine reads from the end (startLine: -20 is the last 20 lines). " +
      "Do not copy the `N|` prefix into edit_file or write_file — it is line-number metadata. " +
      "If truncated is true, read the next range; do not assume you saw the whole file. UTF-8 only; a leading BOM is stripped. " +
      "To follow a file that is still being written, pass sinceByte (from the previous read's nextByte) and sinceInode: you get only what was appended, plus a reset field saying the file was rotated or truncated when the offset stopped meaning anything.",
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
          if (isIncrementalRead(args)) {
            const incremental = yield* Effect.promise(() =>
              readSince(filePathResult, args.sinceByte ?? 0, args.sinceInode),
            );
            const appendedLines = incremental.text === "" ? [] : incremental.text.split(/\r?\n/);
            const requestedMax =
              typeof args.maxBytes === "number" && args.maxBytes > 0
                ? args.maxBytes
                : DEFAULT_MAX_CHARS;
            const capped = trimToMaxChars(appendedLines, Math.min(requestedMax, HARD_MAX_CHARS));

            return {
              success: true,
              result: {
                path: filePathResult,
                content: capped.lines.join("\n"),
                truncated: capped.truncated,
                returnedLines: capped.lines.length,
                // Handed straight back on the next call. A capped response must resume after
                // exactly the source represented here; advancing past the whole disk read would
                // silently discard the omitted tail.
                nextByte: capped.truncated
                  ? nextByteAfterCappedText(incremental, capped.lines)
                  : incremental.nextByte,
                fileSize: incremental.fileSize,
                inode: incremental.inode,
                ...(incremental.reset !== undefined ? { reset: incremental.reset } : {}),
              },
            };
          }

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
