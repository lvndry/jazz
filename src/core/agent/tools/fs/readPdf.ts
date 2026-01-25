import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Read PDF file contents tool
 */

export function createReadPdfTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("PDF file path to read"),
      pages: z
        .array(z.number().int().positive())
        .optional()
        .describe(
          "Specific page numbers to extract (1-based, e.g., [1, 3, 5]). If not provided, extracts all pages.",
        ),
      maxChars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Maximum number of characters to return (content is truncated if exceeded, default: 500KB)",
        ),
    })
    .strict();

  type ReadPdfParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, ReadPdfParams>({
    name: "read_pdf",
    description:
      "Read and extract text content from a PDF file. Supports extracting text from specific pages or all pages. Returns extracted text, page count, and metadata. Use this tool specifically for PDF files; use read_file for text files.",
    tags: ["filesystem", "read", "pdf"],
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
              error: `File is not a PDF: ${filePathResult}. Use read_file for text files.`,
            };
          }

          let PDFParse;
          try {
            const pdfModule = yield* Effect.promise(() => import("pdf-parse"));
            PDFParse = pdfModule.PDFParse;
          } catch (importError) {
            return {
              success: false,
              result: null,
              error: `Failed to read PDF file: ${importError instanceof Error ? importError.message : String(importError)}`,
            };
          }

          const fileBuffer = yield* fs.readFile(filePathResult);

          const pdfParser = new PDFParse({ data: fileBuffer });

          try {
            const parseParams = args.pages ? { partial: args.pages } : undefined;
            const textResult = yield* Effect.promise(() => pdfParser.getText(parseParams));
            let content = (textResult as { text?: string }).text || "";

            // Get metadata
            const infoResult = yield* Effect.promise(() => pdfParser.getInfo());
            const pageCount = (infoResult as { pageCount?: number }).pageCount || 0;

            // Enforce maxChars safeguard
            const maxChars =
              typeof args.maxChars === "number" && args.maxChars > 0 ? args.maxChars : 512000;
            let truncated = false;
            if (content.length > maxChars) {
              content = content.slice(0, maxChars);
              truncated = true;
            }

            // Calculate line counts
            const totalLines = content === "" ? 0 : content.split(/\r?\n/).length;

            return {
              success: true,
              result: {
                path: filePathResult,
                content,
                truncated,
                totalLines,
                pageCount,
                pagesExtracted: args.pages || Array.from({ length: pageCount }, (_, i) => i + 1),
                fileType: "pdf",
              },
            };
          } catch (parseError) {
            return {
              success: false,
              result: null,
              error: `PDF parsing failed: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            };
          } finally {
            yield* Effect.promise(() => pdfParser.destroy()).pipe(
              Effect.catchAll(() => Effect.void),
            );
          }
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `readPdf failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}
