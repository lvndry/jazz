import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import type { FileSystemContextService } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { toError } from "@/core/utils/errors";
import { formatByteSize } from "@/core/utils/string";
import { defineTool, makeZodValidator } from "../base-tool";
import {
  isPdfPasswordError,
  loadPdfParser,
  pdfExtensionError,
  resolveReadableFile,
} from "./read-common";
import { normalizeStatSize } from "./utils";

/**
 * Get PDF file page count tool
 *
 * This tool provides a lightweight way to get the number of pages in a PDF file
 * without reading the entire content. This is useful for:
 * - Planning PDF reading strategies (chunk size, page ranges)
 * - Avoiding context window bloat when processing large PDFs
 * - Checking PDF structure before intensive operations
 */

export function createPdfPageCountTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("Absolute or relative to the working directory."),
      password: z
        .string()
        .min(1)
        .optional()
        .describe("For encrypted PDFs: the placeholder from ask_user_secret."),
    })
    .strict();

  type PdfPageCountParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, PdfPageCountParams>({
    name: "pdf_page_count",
    disclosure: "internal",
    userSecretArguments: ["password"],
    description: "Return a PDF's page count and file size. Call it before read_pdf on a large PDF.",
    tags: ["filesystem", "pdf", "info"],
    parameters,
    validate: makeZodValidator(parameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const resolved = yield* resolveReadableFile(args.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const filePathResult = resolved.path;
        const fs = yield* FileSystem.FileSystem;

        try {
          const pdfError = pdfExtensionError(filePathResult, "Use this tool for PDF files only.");
          if (pdfError) return pdfError;

          const loaded = yield* loadPdfParser("Failed to load PDF parser");
          if (loaded.kind === "failure") return loaded.result;
          const PDFParse = loaded.PDFParse;

          const stat = yield* fs.stat(filePathResult);
          const fileBuffer = yield* fs.readFile(filePathResult);
          const pdfParser = new PDFParse({
            data: fileBuffer,
            ...(args.password !== undefined ? { password: args.password } : {}),
          });

          try {
            // Use getInfo() to extract metadata without processing all content
            const infoResult = yield* Effect.tryPromise({
              try: () => pdfParser.getInfo(),
              catch: toError,
            });
            const pageCount = (infoResult as { pageCount?: number }).pageCount || 0;

            // Extract basic file info for additional context
            const fileSize = normalizeStatSize(stat.size);
            const normalizedSize = formatFileSize(fileSize);

            return {
              success: true,
              result: {
                path: filePathResult,
                pageCount,
                fileSize: normalizedSize,
                fileSizeBytes: fileSize,
              },
            };
          } catch (parseError) {
            if (isPdfPasswordError(parseError)) {
              return {
                success: false,
                result: null,
                error: args.password
                  ? "Failed to extract PDF info: the password provided is incorrect. Ask the person again with ask_user_secret and pass the new placeholder as `password`."
                  : "Failed to extract PDF info: this PDF is password-protected. Ask the person for its password with ask_user_secret and pass the placeholder it returns as `password`.",
              };
            }
            return {
              success: false,
              result: null,
              error: `Failed to extract PDF info: ${toError(parseError).message}`,
            };
          } finally {
            yield* Effect.tryPromise({
              try: () => pdfParser.destroy(),
              catch: toError,
            }).pipe(Effect.catchAll(() => Effect.void));
          }
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `pdf_page_count failed: ${toError(error).message}`,
          };
        }
      }),
  });
}

/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes: number | string | null): string {
  if (bytes === null || bytes === undefined) return "Unknown";
  const numBytes = typeof bytes === "string" ? parseInt(bytes, 10) : bytes;
  return formatByteSize(numBytes);
}
