import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import type { FileSystemContextService } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool, makeZodValidator } from "../base-tool";
import { loadPdfParser, pdfExtensionError, resolveReadableFile } from "./read-common";
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
      path: z.string().min(1).describe("PDF file path"),
    })
    .strict();

  type PdfPageCountParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, PdfPageCountParams>({
    name: "pdf_page_count",
    description:
      "PDF metadata: page count (and file size). Use before read_pdf so you can pass a page list instead of dumping hundreds of pages. Still loads the file; it does not extract text.",
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
          const pdfParser = new PDFParse({ data: fileBuffer });

          try {
            // Use getInfo() to extract metadata without processing all content
            const infoResult = yield* Effect.tryPromise({
              try: () => pdfParser.getInfo(),
              catch: (error) => (error instanceof Error ? error : new Error(String(error))),
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
            return {
              success: false,
              result: null,
              error: `Failed to extract PDF info: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            };
          } finally {
            yield* Effect.tryPromise({
              try: () => pdfParser.destroy(),
              catch: (error) => (error instanceof Error ? error : new Error(String(error))),
            }).pipe(Effect.catchAll(() => Effect.void));
          }
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `pdfPageCount failed: ${error instanceof Error ? error.message : String(error)}`,
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
  if (isNaN(numBytes) || numBytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(numBytes) / Math.log(k));
  return parseFloat((numBytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
