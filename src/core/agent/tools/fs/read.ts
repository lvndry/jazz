import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import type { FileSystemContextService } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool, makeZodValidator } from "../base-tool";
import { attachMediaFile } from "./attach-media";
import { resolveReadableFile, stripUtf8Bom } from "./read-common";

/**
 * Read file contents tool
 */

export function createReadFileTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("File path to read"),
      startLine: z.number().int().positive().optional().describe("1-based start line (inclusive)"),
      endLine: z.number().int().positive().optional().describe("1-based end line (inclusive)"),
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max bytes to return (default: 128KB, cap: 512KB)"),
      encoding: z.string().optional().describe("Text encoding (currently utf-8)"),
    })
    .strict();

  type ReadFileParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, ReadFileParams>({
    name: "read_file",
    description:
      "Read a file with optional line range (startLine/endLine). Text files are returned as " +
      "text; images, PDFs, audio and video are attached to the conversation so the model can " +
      "see or hear them directly, when the active model supports that modality.",
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
          let content = stripUtf8Bom(yield* fs.readFileString(filePathResult));

          let totalLines = 0;
          let returnedLines = 0;
          let rangeStart: number | undefined = undefined;
          let rangeEnd: number | undefined = undefined;

          // Apply line range if provided
          if (args.startLine !== undefined || args.endLine !== undefined) {
            const lines = content.split(/\r?\n/);
            totalLines = lines.length;
            const start = Math.max(1, args.startLine ?? 1);
            const rawEnd = args.endLine ?? totalLines;
            const end = Math.max(start, Math.min(rawEnd, totalLines));
            content = lines.slice(start - 1, end).join("\n");
            returnedLines = end - start + 1;
            rangeStart = start;
            rangeEnd = end;
          } else {
            // If no range, we can still report total lines lazily without splitting twice
            totalLines = content === "" ? 0 : content.split(/\r?\n/).length;
            returnedLines = totalLines;
          }

          // Enforce maxBytes safeguard (approximate by string length)
          const requestedMaxBytes =
            typeof args.maxBytes === "number" && args.maxBytes > 0 ? args.maxBytes : 131_072;
          const maxBytes = Math.min(requestedMaxBytes, 524_288);
          let truncated = false;
          if (content.length > maxBytes) {
            content = content.slice(0, maxBytes);
            truncated = true;
          }

          return {
            success: true,
            result: {
              path: filePathResult,
              encoding: (args.encoding ?? "utf-8").toLowerCase(),
              content,
              truncated,
              totalLines,
              returnedLines,
              range:
                rangeStart !== undefined ? { startLine: rangeStart, endLine: rangeEnd } : undefined,
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
