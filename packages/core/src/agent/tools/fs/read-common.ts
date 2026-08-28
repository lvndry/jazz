/**
 * Shared path resolution and PDF loading for filesystem read tools.
 */
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { buildKeyFromContext } from "../context-utils";

export type FsToolDeps = FileSystem.FileSystem | FileSystemContextService;

export type ResolvedReadableFile =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "failure"; readonly result: ToolExecutionResult };

type PdfParseConstructor = new (options: { data: Uint8Array; password?: string }) => {
  getInfo: () => Promise<unknown>;
  getText: (...args: readonly unknown[]) => Promise<unknown>;
  getTable: (...args: readonly unknown[]) => Promise<unknown>;
  destroy: () => Promise<void>;
};

export type LoadedPdfParser =
  | { readonly kind: "ok"; readonly PDFParse: PdfParseConstructor }
  | { readonly kind: "failure"; readonly result: ToolExecutionResult };

/**
 * Resolve a path to an existing file, or a tool failure if missing or a directory.
 */
export function resolveReadableFile(
  requestedPath: string,
  context: ToolExecutionContext,
): Effect.Effect<ResolvedReadableFile, never, FsToolDeps> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const shell = yield* FileSystemContextServiceTag;
    const filePath = yield* shell
      .resolvePath(buildKeyFromContext(context), requestedPath)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));

    if (filePath === null) {
      return {
        kind: "failure",
        result: {
          success: false,
          result: null,
          error: `Path not found: ${requestedPath}`,
        },
      };
    }

    const stat = yield* fs.stat(filePath).pipe(Effect.either);
    if (stat._tag === "Left") {
      return {
        kind: "failure",
        result: {
          success: false,
          result: null,
          error: `Path not found: ${requestedPath}`,
        },
      };
    }

    if (stat.right.type === "Directory") {
      return {
        kind: "failure",
        result: {
          success: false,
          result: null,
          error: `Not a file: ${filePath}`,
        },
      };
    }

    return { kind: "file", path: filePath };
  });
}

export function stripUtf8Bom(content: string): string {
  return content.length > 0 && content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

export function pdfExtensionError(filePath: string, hint: string): ToolExecutionResult | null {
  if (filePath.toLowerCase().endsWith(".pdf")) return null;
  return {
    success: false,
    result: null,
    error: `File is not a PDF: ${filePath}. ${hint}`,
  };
}

/** True if a pdf.js/pdf-parse error indicates the PDF is encrypted and needs (or rejected) a password. */
export function isPdfPasswordError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /password/i.test(message) || /encrypted/i.test(message);
}

export function loadPdfParser(failurePrefix: string): Effect.Effect<LoadedPdfParser, never> {
  return Effect.tryPromise({
    try: () => import("pdf-parse"),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(
    Effect.map((pdfModule): LoadedPdfParser => ({
      kind: "ok",
      PDFParse: pdfModule.PDFParse as PdfParseConstructor,
    })),
    Effect.catchAll((error) =>
      Effect.succeed({
        kind: "failure" as const,
        result: {
          success: false,
          result: null,
          error: `${failurePrefix}: ${error instanceof Error ? error.message : String(error)}`,
        },
      }),
    ),
  );
}
