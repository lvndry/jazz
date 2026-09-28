/**
 * The `read` tool: returns file contents numbered for coding-model consumption,
 * with an optional line range (negative values count from the end of the file)
 * and a hard character cap to avoid flooding the context window. Ordinary text reads
 * also return a snapshot of the canonical path and complete contents for edit_file.
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
import { redactLines } from "@/core/secrets/redacted-lines";
import type { KnownSecret } from "@/core/secrets/redaction";
import { toError } from "@/core/utils/errors";
import { defineTool, makeZodValidator } from "../base-tool";
import { toolKnownSecrets } from "../tool-secrets";
import { attachMediaFile } from "./attach-media";
import { fileSnapshot } from "./file-snapshot";
import { localFileProvenance, resolveReadableFile, stripUtf8Bom } from "./read-common";

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

/**
 * Bytes before `sinceByte` read along with the appended text, so a secret that began before the
 * offset (a private key block, the name half of `NAME=value`) is recognized with its context.
 */
const REDACTION_LOOKBACK_BYTES = 16 * 1024;

const NEWLINE_BYTE = 0x0a;
const CARRIAGE_RETURN_BYTE = 0x0d;

/** One line of an incremental read, as shown and as it sits in the file. */
interface IncrementalLine {
  /** The line as returned: redacted, without its line ending. */
  readonly text: string;
  /** Byte offset in the file where `text`'s source begins. */
  readonly startByte: number;
  /** Byte offset just past the line's ending, or the end of the read for the last line. */
  readonly endByte: number;
  /** The line holds a secret, so `text` is not a character-for-character copy of the file. */
  readonly secret: boolean;
}

/** What a `sinceByte` read found, redacted, before capping is applied. */
interface IncrementalRead {
  readonly lines: readonly IncrementalLine[];
  readonly nextByte: number;
  readonly fileSize: number;
  readonly inode: number;
  /** Set when `sinceByte` was ignored and the read restarted at 0, with the reason why. */
  readonly reset?: "rotated" | "truncated";
}

/** Split `buffer` (which begins at file offset `baseByte`) into lines with their byte spans. */
function splitLinesWithOffsets(
  buffer: Buffer,
  baseByte: number,
): Array<{ text: string; startByte: number; endByte: number }> {
  const lines: Array<{ text: string; startByte: number; endByte: number }> = [];
  let lineStart = 0;
  for (;;) {
    const newline = buffer.indexOf(NEWLINE_BYTE, lineStart);
    if (newline === -1) {
      lines.push({
        text: buffer.subarray(lineStart).toString("utf8"),
        startByte: baseByte + lineStart,
        endByte: baseByte + buffer.length,
      });
      return lines;
    }
    const contentEnd =
      newline > lineStart && buffer[newline - 1] === CARRIAGE_RETURN_BYTE ? newline - 1 : newline;
    lines.push({
      text: buffer.subarray(lineStart, contentEnd).toString("utf8"),
      startByte: baseByte + lineStart,
      endByte: baseByte + newline + 1,
    });
    lineStart = newline + 1;
  }
}

/**
 * Read the bytes appended after `sinceByte`, restarting at 0 when the offset went stale, and
 * redact them with the lines before the offset as context.
 *
 * Rotation needs the inode, not the size: a renamed-away log's replacement is often *longer* than
 * the old offset, so a size check sees a valid offset into unrelated content. Truncation in place
 * keeps the inode and drops below the offset.
 *
 * An offset in the middle of a line holding a secret returns that whole line, redacted: the
 * part after the offset alone could be the secret with nothing left to recognize it by.
 */
async function readSince(
  filePath: string,
  sinceByte: number,
  sinceInode: number | undefined,
  known: readonly KnownSecret[],
): Promise<IncrementalRead> {
  const stats = await stat(filePath);
  const inode = Number(stats.ino);
  const fileSize = stats.size;

  const rotated = sinceInode !== undefined && sinceInode !== inode;
  const truncated = fileSize < sinceByte;
  const start = rotated || truncated ? 0 : sinceByte;
  const reset = rotated
    ? { reset: "rotated" as const }
    : truncated
      ? { reset: "truncated" as const }
      : {};

  if (fileSize <= start) {
    return { lines: [], nextByte: fileSize, fileSize, inode, ...reset };
  }

  const readFrom = Math.max(0, start - REDACTION_LOOKBACK_BYTES);
  const handle = await open(filePath, "r");
  let buffer: Buffer;
  try {
    const length = fileSize - readFrom;
    const allocated = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(allocated, 0, length, readFrom);
    buffer = allocated.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const readEnd = readFrom + buffer.length;
  if (readEnd <= start) {
    return { lines: [], nextByte: readEnd, fileSize, inode, ...reset };
  }

  // The lookback usually starts mid-line; context begins at the first whole line in it.
  let contextStart = 0;
  if (readFrom > 0) {
    const firstNewline = buffer.indexOf(NEWLINE_BYTE);
    contextStart =
      firstNewline !== -1 && readFrom + firstNewline < start ? firstNewline + 1 : start - readFrom;
  }
  const sourceLines = splitLinesWithOffsets(buffer.subarray(contextStart), readFrom + contextStart);
  const view = redactLines(
    sourceLines.map((line) => line.text),
    known,
  );

  const firstIndex = sourceLines.findIndex((line) => line.endByte > start);
  const lines: IncrementalLine[] = [];
  for (let index = Math.max(firstIndex, 0); index < sourceLines.length; index++) {
    const source = sourceLines[index];
    if (source === undefined) {
      continue;
    }
    const secret = view.secretLineIndexes.has(index);
    const text = view.lines[index] ?? "";
    if (index === firstIndex && source.startByte < start && !secret) {
      const suffix = buffer
        .subarray(start - readFrom, source.endByte - readFrom)
        .toString("utf8")
        .replace(/\r?\n$/, "");
      lines.push({ text: suffix, startByte: start, endByte: source.endByte, secret });
      continue;
    }
    lines.push({ text, startByte: source.startByte, endByte: source.endByte, secret });
  }
  return { lines, nextByte: readEnd, fileSize, inode, ...reset };
}

/**
 * The byte cursor immediately after the source represented by a capped incremental response.
 *
 * `trimToMaxChars` returns whole lines where it can, so the next read starts past the last
 * returned line's ending. When a single line is longer than the cap, it returns a character
 * prefix of that line: the cursor lands after that prefix's bytes, or, for a line holding a
 * secret, whose redacted text has no byte-for-byte source, after the whole line.
 */
function nextByteAfterCappedText(
  incremental: IncrementalRead,
  returnedLines: readonly string[],
): number {
  const lastIndex = returnedLines.length - 1;
  const lastLine = incremental.lines[lastIndex];
  const lastReturned = returnedLines[lastIndex];
  if (lastLine === undefined || lastReturned === undefined) {
    return incremental.lines[0]?.startByte ?? incremental.nextByte;
  }
  if (lastReturned.length < lastLine.text.length && !lastLine.secret) {
    return lastLine.startByte + Buffer.byteLength(lastReturned);
  }
  return lastLine.endByte;
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
      path: z.string().min(1).describe("File, absolute or relative to the working directory."),
      startLine: lineIndexSchema
        .optional()
        .describe("First line, 1-based, inclusive; negative counts from the end (-20 = last 20)."),
      endLine: lineIndexSchema
        .optional()
        .describe("Last line, inclusive; negative counts from the end."),
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Character limit on the result. Default 131072, cap 524288."),
      sinceByte: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "nextByte from the previous read; returns only text appended since. Use without startLine/endLine.",
        ),
      sinceInode: z
        .number()
        .int()
        .optional()
        .describe("inode from the previous read; pass with sinceByte to detect rotation."),
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
      "Read a file; for a directory, use ls. Text comes back as numbered `N|` lines plus a snapshot to pass to edit_file; copy only the text after `N|` into edits. " +
      "Secret values appear as `[redacted:<name>]`. Images, PDFs, audio and video are attached when the model supports them. If truncated is true, read the next range. " +
      "To follow a growing file, pass sinceByte and sinceInode from the previous read; a reset field flags rotation or truncation.",
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
        const known = yield* toolKnownSecrets();
        const mediaOutcome = yield* Effect.promise(() =>
          attachMediaFile(filePathResult, context, known),
        );
        if (mediaOutcome.kind !== "not-media") return mediaOutcome.result;

        const untrusted = yield* localFileProvenance(filePathResult, "read_file", context);
        const provenance = untrusted !== undefined ? { untrusted } : {};

        try {
          if (isIncrementalRead(args)) {
            const incremental = yield* Effect.promise(() =>
              readSince(filePathResult, args.sinceByte ?? 0, args.sinceInode, known),
            );
            const appendedLines = incremental.lines.map((line) => line.text);
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
              ...provenance,
            };
          }

          const canonicalPath = yield* fs.realPath(filePathResult);
          const fileContent = yield* fs.readFileString(canonicalPath);
          const raw = stripUtf8Bom(fileContent);
          const allLines = raw === "" ? [] : redactLines(raw.split(/\r?\n/), known).lines;
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
              snapshot: fileSnapshot(canonicalPath, fileContent),
              content: formatNumberedContent(trimmed.lines, range.startLine),
              truncated: trimmed.truncated,
              totalLines,
              returnedLines,
              range:
                totalLines === 0
                  ? undefined
                  : { startLine: range.startLine, endLine: Math.max(range.startLine, rangeEnd) },
            },
            ...provenance,
          };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `readFile failed: ${toError(error).message}`,
          };
        }
      }),
  });
}
