import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";
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
    description: "Get total page count of a PDF without reading content.",
    tags: ["filesystem", "pdf", "info"],
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

          if (!filePathResult.toLowerCase().endsWith(".pdf")) {
            return {
              success: false,
              result: null,
              error: `File is not a PDF: ${filePathResult}. Use this tool for PDF files only.`,
            };
          }

          let PDFParse;
          try {
            const pdfModule = yield* Effect.tryPromise({
              try: () => import("pdf-parse"),
              catch: (error) => (error instanceof Error ? error : new Error(String(error))),
            });
            PDFParse = pdfModule.PDFParse;
          } catch (importError) {
            return {
              success: false,
              result: null,
              error: `Failed to load PDF parser: ${importError instanceof Error ? importError.message : String(importError)}`,
            };
          }

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
