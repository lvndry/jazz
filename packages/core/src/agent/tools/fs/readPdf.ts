import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import type { FileSystemContextService } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineTool, makeZodValidator } from "../base-tool";
import { fetchWithUserAgentFallback } from "../user-agent-fetch";
import {
  type FsToolDeps,
  isPdfPasswordError,
  loadPdfParser,
  pdfExtensionError,
  resolveReadableFile,
} from "./read-common";

/**
 * Read PDF file contents tool
 */

// pdf-parse holds the whole document in memory and a truncated PDF is unusable, so an oversized
// remote PDF is rejected outright rather than capped. 50 MB covers large scanned reports while
// bounding a single in-memory buffer.
const MAX_PDF_DOWNLOAD_BYTES = 50 * 1024 * 1024;

// A remote PDF can be a large download; allow noticeably longer than a typical API call before
// giving up.
const PDF_DOWNLOAD_TIMEOUT_MS = 30_000;

type PdfBytes =
  | { readonly kind: "ok"; readonly buffer: Uint8Array; readonly label: string }
  | { readonly kind: "failure"; readonly result: ToolExecutionResult };

function pdfFailure(error: string): PdfBytes {
  return { kind: "failure", result: { success: false, result: null, error } };
}

/** The PDF file header. A valid PDF begins with these bytes (possibly after a little leading junk). */
function looksLikePdf(buffer: Uint8Array): boolean {
  const prefix = new TextDecoder("latin1").decode(buffer.subarray(0, 1024));
  return prefix.includes("%PDF-");
}

/** Read a local PDF into a buffer, reusing the shared path resolution and extension check. */
function loadLocalPdf(
  path: string,
  context: ToolExecutionContext,
): Effect.Effect<PdfBytes, never, FsToolDeps> {
  return Effect.gen(function* () {
    const resolved = yield* resolveReadableFile(path, context);
    if (resolved.kind === "failure") return resolved;

    const extensionError = pdfExtensionError(resolved.path, "Use read_file for text files.");
    if (extensionError) return { kind: "failure", result: extensionError };

    const fs = yield* FileSystem.FileSystem;
    const buffer = yield* fs.readFile(resolved.path).pipe(Effect.either);
    if (buffer._tag === "Left") {
      return pdfFailure(`Failed to read PDF file: ${resolved.path}`);
    }
    return { kind: "ok", buffer: buffer.right, label: resolved.path };
  });
}

/** Download a remote PDF into a buffer over http/https, enforcing a timeout and size cap. */
function loadRemotePdf(url: string): Effect.Effect<PdfBytes, never> {
  return Effect.gen(function* () {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return pdfFailure(`Invalid URL: ${url}`);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return pdfFailure("Only http and https URLs are supported.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PDF_DOWNLOAD_TIMEOUT_MS);
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchWithUserAgentFallback(url, {
          signal: controller.signal,
          accept: "application/pdf,*/*",
        }),
      catch: (error) =>
        error instanceof Error && error.name === "AbortError"
          ? new Error(`Download timed out after ${PDF_DOWNLOAD_TIMEOUT_MS}ms.`)
          : new Error(
              `Failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`,
            ),
    }).pipe(Effect.either);
    clearTimeout(timeout);

    if (response._tag === "Left") return pdfFailure(response.left.message);
    if (!response.right.ok) {
      return pdfFailure(`HTTP ${response.right.status} ${response.right.statusText} for ${url}`);
    }

    const declaredLength = Number(response.right.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_DOWNLOAD_BYTES) {
      return pdfFailure(
        `PDF is too large to download (${declaredLength} bytes; limit ${MAX_PDF_DOWNLOAD_BYTES}).`,
      );
    }

    const bytes = yield* Effect.tryPromise({
      try: () => response.right.arrayBuffer(),
      catch: (error) =>
        new Error(
          `Failed to read response body: ${error instanceof Error ? error.message : String(error)}`,
        ),
    }).pipe(Effect.either);
    if (bytes._tag === "Left") return pdfFailure(bytes.left.message);

    const buffer = new Uint8Array(bytes.right);
    if (buffer.byteLength > MAX_PDF_DOWNLOAD_BYTES) {
      return pdfFailure(
        `PDF is too large to download (${buffer.byteLength} bytes; limit ${MAX_PDF_DOWNLOAD_BYTES}).`,
      );
    }
    if (!looksLikePdf(buffer)) {
      return pdfFailure(
        `The URL did not return a PDF (missing %PDF header). Use web_fetch for HTML pages.`,
      );
    }
    return { kind: "ok", buffer, label: url };
  });
}

function loadPdfBytes(
  args: { readonly path?: string | undefined; readonly url?: string | undefined },
  context: ToolExecutionContext,
): Effect.Effect<PdfBytes, never, FsToolDeps> {
  if (args.url !== undefined) return loadRemotePdf(args.url);
  if (args.path !== undefined) return loadLocalPdf(args.path, context);
  return Effect.succeed(pdfFailure("Provide exactly one of path or url."));
}

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
      path: z
        .string()
        .min(1)
        .optional()
        .describe("Local PDF path. Pass exactly one of path or url."),
      url: z
        .url({
          protocol: /^https?$/,
          error: "URL must be absolute and include the protocol (http or https).",
        })
        .optional()
        .describe("http(s) URL of a PDF to download."),
      pages: z
        .array(z.number().int().positive())
        .optional()
        .describe("1-based page numbers, e.g. [1, 2, 3]. Omit to read all."),
      maxChars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max characters returned. Default 512000."),
      password: z.string().min(1).optional().describe("For encrypted PDFs."),
    })
    .strict()
    .refine((value) => (value.path === undefined) !== (value.url === undefined), {
      error: "Provide exactly one of path or url.",
    });

  type ReadPdfParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, ReadPdfParams>({
    name: "read_pdf",
    disclosure: "private",
    // With `url`, the model chooses an address to fetch, so bytes can ride out in the path or
    // query string just as with web_fetch. That makes this an egress tool even though its local
    // `path` mode touches nothing but disk.
    egress: true,
    description:
      "Extract text and tables from a local or remote PDF's text layer. For a large PDF, call pdf_page_count first, then read 10–20 pages per call.",
    tags: ["filesystem", "read", "pdf"],
    parameters,
    validate: makeZodValidator(parameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const source = yield* loadPdfBytes(args, context);
        if (source.kind === "failure") return source.result;
        const sourceLabel = source.label;

        const loaded = yield* loadPdfParser("Failed to read PDF file");
        if (loaded.kind === "failure") return loaded.result;
        const PDFParse = loaded.PDFParse;

        // pdf-parse rejects on malformed or encrypted input, so every call runs through
        // `Effect.either`: the failures are values to turn into clean tool errors, not thrown
        // exceptions. `Effect.ensuring` releases the parser whether parsing succeeds or fails.
        const pdfParser = new PDFParse({
          data: source.buffer,
          ...(args.password !== undefined ? { password: args.password } : {}),
        });
        const parseParams = args.pages ? { partial: args.pages } : undefined;

        return yield* Effect.gen(function* () {
          const textResult = yield* Effect.tryPromise({
            try: () => pdfParser.getText(parseParams),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          }).pipe(Effect.either);
          if (textResult._tag === "Left") {
            const parseError = textResult.left;
            return {
              success: false,
              result: null,
              error: isPdfPasswordError(parseError)
                ? args.password
                  ? "PDF parsing failed: the password provided is incorrect."
                  : "PDF parsing failed: this PDF is password-protected. Retry with the `password` argument."
                : `PDF parsing failed: ${parseError.message}`,
            } satisfies ToolExecutionResult;
          }
          const textContent = (textResult.right as { text?: string }).text || "";

          // Extract tables (with page attribution); ignore errors so text-only extraction still works
          let tablesSection = "";
          let extractedTables: Array<{ pageNumber: number; rows: string[][] }> = [];
          const tableResult = yield* Effect.tryPromise({
            try: () => pdfParser.getTable(parseParams as { partial?: number[] }),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          }).pipe(Effect.either);
          if (tableResult._tag === "Right") {
            const built = buildTablesSection(
              tableResult.right as {
                pages?: Array<{ num?: number; tables?: (readonly (readonly string[])[])[] }>;
              },
            );
            tablesSection = built.section;
            extractedTables = built.tables;
          } else {
            yield* Effect.logDebug(
              `PDF table extraction failed, continuing with text only. Error: ${tableResult.left.message}`,
            );
          }

          // Combine text and tables so reader sees one document with page-labeled tables
          let content = textContent + tablesSection;

          const infoResult = yield* Effect.tryPromise({
            try: () => pdfParser.getInfo(),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          }).pipe(Effect.either);
          const pageCount =
            infoResult._tag === "Right" ? (infoResult.right as { total?: number }).total || 0 : 0;

          // Enforce maxChars safeguard on combined content
          const maxChars =
            typeof args.maxChars === "number" && args.maxChars > 0 ? args.maxChars : 512_000;
          let truncated = false;
          if (content.length > maxChars) {
            content = content.slice(0, maxChars);
            truncated = true;
          }

          const totalLines = content === "" ? 0 : content.split(/\r?\n/).length;

          return {
            success: true,
            result: {
              path: sourceLabel,
              content,
              truncated,
              totalLines,
              pageCount,
              pagesExtracted: args.pages || Array.from({ length: pageCount }, (_, i) => i + 1),
              fileType: "pdf",
              tables: extractedTables,
            },
          } satisfies ToolExecutionResult;
        }).pipe(
          Effect.ensuring(
            Effect.tryPromise({
              try: () => pdfParser.destroy(),
              catch: (error) => (error instanceof Error ? error : new Error(String(error))),
            }).pipe(Effect.catchAll(() => Effect.void)),
          ),
          Effect.catchAll((error: Error) =>
            Effect.succeed({
              success: false,
              result: null,
              error: `readPdf failed: ${error.message}`,
            } satisfies ToolExecutionResult),
          ),
        );
      }),
  });
}
