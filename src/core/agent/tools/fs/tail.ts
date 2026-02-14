import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Read last N lines of a file tool
 */

export function createTailTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("File path to read"),
      lines: z.number().int().positive().optional().describe("Lines from end (default: 10)"),
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max bytes (truncated if exceeded)"),
    })
    .strict();

  type TailParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, TailParams>({
    name: "tail",
    description: "Read the last N lines of a file (default 10).",
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

        // If path resolution failed, return the error
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

          const lines = content.split(/\r?\n/);
          const totalLines = lines.length;
          const requestedLines = args.lines ?? 10;
          const returnedLines = Math.min(requestedLines, totalLines);

          // Get the last N lines
          const startIndex = Math.max(0, totalLines - returnedLines);
          let tailContent = lines.slice(startIndex).join("\n");

          // Enforce maxBytes safeguard (approximate by string length)
          const maxBytes =
            typeof args.maxBytes === "number" && args.maxBytes > 0 ? args.maxBytes : 131_072;
          let truncated = false;

          if (tailContent.length > maxBytes) {
            tailContent = tailContent.slice(-maxBytes);
            truncated = true;
          }

          return {
            success: true,
            result: {
              path: filePathResult,
              content: tailContent,
              truncated,
              totalLines,
              returnedLines,
              requestedLines,
              startLine: startIndex + 1, // 1-based line number
              endLine: totalLines,
            },
          };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `tail failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}
