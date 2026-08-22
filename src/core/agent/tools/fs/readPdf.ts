import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import type { FileSystemContextService } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool, makeZodValidator } from "../base-tool";
import { loadPdfParser, pdfExtensionError, resolveReadableFile } from "./read-common";

/**
 * Read PDF file contents tool
 */

/** Format a single table (rows of cell strings) as markdown. */
function formatTableAsMarkdown(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";
  const first = rows[0]!;
  const safe = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const rowToLine = (row: readonly string[]) =>
    "| " + row.map((c) => safe(String(c ?? ""))).join(" | ") + " |";
  const header = rowToLine(first);
  const separator = "| " + first.map(() => "---").join(" | ") + " |";
  const body = rows
    .slice(1)
    .map((row) => rowToLine(row ?? []))
    .join("\n");
  return [header, separator, body].join("\n");
}

/** Build tables section with page attribution from pdf-parse getTable result. */
function buildTablesSection(getTableResult: {
  pages?: Array<{ num?: number; tables?: (readonly (readonly string[])[])[] }>;
}): { section: string; tables: Array<{ pageNumber: number; rows: string[][] }> } {
  const tables: Array<{ pageNumber: number; rows: string[][] }> = [];
  const parts: string[] = [];
  const pages = getTableResult.pages ?? [];
  for (const page of pages) {
    const pageNum = typeof page.num === "number" ? page.num : 0;
    const pageTables = page.tables ?? [];
    if (pageTables.length === 0) continue;
    parts.push(`### Page ${pageNum + 1}`);
    for (let i = 0; i < pageTables.length; i++) {
      const table = pageTables[i];
      if (table === undefined) continue;
      const rows = table.map((row) => [...(row ?? []).map((c) => String(c ?? ""))]);
      tables.push({ pageNumber: pageNum + 1, rows });
      const label = pageTables.length > 1 ? ` (Table ${i + 1})` : "";
      parts.push(`#### Table${label}`);
      parts.push(formatTableAsMarkdown(rows));
    }
    parts.push("");
  }
  const section =
    parts.length === 0 ? "" : "\n\n## Extracted tables\n\n" + parts.join("\n").trimEnd();
  return { section, tables };
}

export function createReadPdfTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("PDF file path to read"),
      pages: z
        .array(z.number().int().positive())
        .optional()
        .describe("Page numbers to extract (1-based). Omit for all pages."),
      maxChars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max characters to return (default: 500KB). Truncated if exceeded."),
    })
    .strict();

  type ReadPdfParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, ReadPdfParams>({
    name: "read_pdf",
    description:
      'Extract text and tables from a PDF. Do not use read_file on PDFs. Use pdf_page_count first for large files, then pass pages as a list of 1-based page numbers (e.g. [1,2,3], not "1-3"). No OCR/images.',
    tags: ["filesystem", "read", "pdf"],
    parameters,
    validate: makeZodValidator(parameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const resolved = yield* resolveReadableFile(args.path, context);
        if (resolved.kind === "failure") return resolved.result;
        const filePathResult = resolved.path;
        const fs = yield* FileSystem.FileSystem;

        try {
          const pdfError = pdfExtensionError(filePathResult, "Use read_file for text files.");
          if (pdfError) return pdfError;

          const loaded = yield* loadPdfParser("Failed to read PDF file");
          if (loaded.kind === "failure") return loaded.result;
          const PDFParse = loaded.PDFParse;

          const fileBuffer = yield* fs.readFile(filePathResult);
          const pdfParser = new PDFParse({ data: fileBuffer });

          try {
            const parseParams = args.pages ? { partial: args.pages } : undefined;
            const textResult = yield* Effect.tryPromise({
              try: () => pdfParser.getText(parseParams),
              catch: (error) => (error instanceof Error ? error : new Error(String(error))),
            });
            const textContent = (textResult as { text?: string }).text || "";

            // Extract tables (with page attribution); ignore errors so text-only extraction still works
            let tablesSection = "";
            let extractedTables: Array<{ pageNumber: number; rows: string[][] }> = [];
            try {
              const tableResult = yield* Effect.tryPromise({
                try: () => pdfParser.getTable(parseParams as { partial?: number[] }),
                catch: (error) => (error instanceof Error ? error : new Error(String(error))),
              });
              const built = buildTablesSection(
                tableResult as {
                  pages?: Array<{ num?: number; tables?: (readonly (readonly string[])[])[] }>;
                },
              );
              tablesSection = built.section;
              extractedTables = built.tables;
            } catch (tableError) {
              // No tables or getTable failed; continue with text only
              yield* Effect.logDebug(
                `PDF table extraction failed, continuing with text only. Error: ${tableError instanceof Error ? tableError.message : String(tableError)}`,
              );
            }

            // Combine text and tables so reader sees one document with page-labeled tables
            let content = textContent + tablesSection;

            // Get metadata
            const infoResult = yield* Effect.tryPromise({
              try: () => pdfParser.getInfo(),
              catch: (error) => (error instanceof Error ? error : new Error(String(error))),
            });
            const pageCount = (infoResult as { pageCount?: number }).pageCount || 0;

            // Enforce maxChars safeguard on combined content
            const maxChars =
              typeof args.maxChars === "number" && args.maxChars > 0 ? args.maxChars : 512_000;
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
                tables: extractedTables,
              },
            };
          } catch (parseError) {
            return {
              success: false,
              result: null,
              error: `PDF parsing failed: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
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
            error: `readPdf failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}
