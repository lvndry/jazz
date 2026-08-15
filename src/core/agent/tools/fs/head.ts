import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import type { FileSystemContextService } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool, makeZodValidator } from "../base-tool";
import { resolveReadableFile, stripUtf8Bom } from "./read-common";

/**
 * Read first N lines of a file tool
 */

export function createHeadTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("File path to read"),
      lines: z
        .number()
        .int()
        .positive()
        .optional()
        .default(10)
        .describe("Lines from beginning (default: 10)"),
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max bytes (truncated if exceeded)"),
    })
    .strict();

  type HeadParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, HeadParams>({
    name: "head",
    description: "Read the first N lines of a file (default 10).",
    tags: ["filesystem", "read"],
    parameters,
    validate: makeZodValidator(parameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const resolved = yield* resolveReadableFile(args.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const filePathResult = resolved.path;
        const fs = yield* FileSystem.FileSystem;

        try {
          const content = stripUtf8Bom(yield* fs.readFileString(filePathResult));

          const lines = content.split(/\r?\n/);
          const totalLines = lines.length;
          const requestedLines = args.lines;
          const returnedLines = Math.min(requestedLines, totalLines);

          // Enforce maxBytes safeguard (approximate by string length)
          const maxBytes =
            typeof args.maxBytes === "number" && args.maxBytes > 0 ? args.maxBytes : 131_072;
          let truncated = false;
          let headContent = lines.slice(0, returnedLines).join("\n");

          if (headContent.length > maxBytes) {
            headContent = headContent.slice(0, maxBytes);
            truncated = true;
          }

          return {
            success: true,
            result: {
              path: filePathResult,
              content: headContent,
              truncated,
              totalLines,
              returnedLines,
              requestedLines,
            },
          };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `head failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}
