import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Read file contents tool
 */

export function createReadFileTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("File path to read (relative to cwd allowed)"),
      startLine: z.number().int().positive().optional().describe("1-based start line (inclusive)"),
      endLine: z.number().int().positive().optional().describe("1-based end line (inclusive)"),
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Maximum number of bytes to return (default: 128KB, hard cap: 512KB). Content is truncated if exceeded.",
        ),
      encoding: z.string().optional().describe("Text encoding (currently utf-8)"),
    })
    .strict();

  type ReadFileParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, ReadFileParams>({
    name: "read_file",
    description:
      "Read the contents of a text file with optional line range selection (startLine/endLine). Automatically handles UTF-8 BOM, enforces size limits to prevent memory issues (default 128KB, hard cap 512KB), and reports truncation. Returns file content, encoding, line counts, and range information.",
    tags: ["filesystem", "read"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? {
            valid: true,
            value: params.data,
          }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const filePathResult = yield* shell
          .resolvePath(buildKeyFromContext(context), args.path)
          .pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (filePathResult === null) {
          return {
            success: false,
            result: null,
            error: `Path not found: ${args.path}`,
          };
        }

        try {
          const stat = yield* fs.stat(filePathResult);
          if (stat.type === "Directory") {
            return { success: false, result: null, error: `Not a file: ${filePathResult}` };
          }

          let content = yield* fs.readFileString(filePathResult);

          // Strip UTF-8 BOM if present
          if (content.length > 0 && content.charCodeAt(0) === 0xfeff) {
            content = content.slice(1);
          }

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
