/**
 * @fileoverview Rendering a PDF from HTML the agent wrote
 *
 * Deliberately not a model capability. Three models in the whole models.dev catalog claim PDF
 * output, while every provider can write HTML — and the same Chromium jazz already needs for
 * `create_web_app`'s static mode turns that HTML into a PDF via `page.pdf()`. That makes PDF the
 * only generated format that is exact, reproducible, free, and works offline on every provider
 * including local models.
 *
 * Unlike `create_web_app`, the output lands in the user's working directory by default. That
 * tool writes into jazz's own home because only a bridge ever read its path; a person running
 * `jazz run "turn these notes into a PDF"` in a terminal wants the file where they are, not
 * buried in `~/.jazz`.
 */

import { isAbsolute, resolve as resolvePath } from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import puppeteer from "puppeteer-core";
import { z } from "zod";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { GeneratedArtifact } from "@/core/types/artifact";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import { defineTool, makeZodValidator } from "./base-tool";
import { buildKeyFromContext } from "./context-utils";
import {
  type BrowserExecutableLookup,
  createSystemBrowserLookup,
  resolveBrowserExecutablePath,
} from "./web-app-tools";

export const MISSING_BROWSER_FOR_PDF_ERROR =
  "create_pdf needs a Chrome or Chromium install to render the page, and none was found. " +
  "Install Google Chrome or Chromium, or point PUPPETEER_EXECUTABLE_PATH at an existing browser " +
  "binary.";

const createPdfParameters = z
  .object({
    html: z
      .string()
      .min(1)
      .describe("Complete HTML document to render. Inline any CSS; @page rules control margins."),
    title: z.string().min(1).describe("Short title, used for the filename when path is omitted."),
    path: z
      .string()
      .optional()
      .describe(
        "Where to write the PDF. Relative paths resolve against the working directory. Defaults to <title>.pdf in the working directory.",
      ),
    landscape: z.boolean().optional().describe("Landscape orientation (default: portrait)."),
    format: z
      .enum(["A4", "Letter", "Legal", "A3", "A5"])
      .optional()
      .describe("Page size (default: A4)."),
  })
  .strict();

type CreatePdfArgs = z.infer<typeof createPdfParameters>;

/**
 * Filename from a title: lowercase, punctuation collapsed to hyphens.
 *
 * Only used when the caller gave no path. Falls back to a fixed name rather than an empty one
 * for a title that is entirely punctuation.
 */
export function pdfFilenameFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug.length > 0 ? slug : "document"}.pdf`;
}

/** Absolute destination for the PDF, honouring an explicit path over the derived filename. */
export function resolvePdfOutputPath(
  args: Pick<CreatePdfArgs, "path" | "title">,
  workingDirectory: string,
): string {
  const requested = args.path ?? pdfFilenameFromTitle(args.title);
  return isAbsolute(requested) ? requested : resolvePath(workingDirectory, requested);
}

async function renderPdf(
  htmlPath: string,
  pdfPath: string,
  executablePath: string,
  options: { landscape: boolean; format: NonNullable<CreatePdfArgs["format"]> },
): Promise<void> {
  const browser = await puppeteer.launch({
    browser: "chrome",
    executablePath,
    headless: true,
    // Same reason as the screenshot path: Chromium's sandbox needs kernel privileges most
    // containers do not grant.
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0" });
    await page.pdf({
      path: pdfPath,
      format: options.format,
      landscape: options.landscape,
      // Backgrounds are off by default in print, which silently strips every styled header and
      // table stripe the model wrote.
      printBackground: true,
    });
  } finally {
    await browser.close();
  }
}

export function createPdfTool(
  browserLookup: () => BrowserExecutableLookup = createSystemBrowserLookup,
): Tool<FileSystem.FileSystem | FileSystemContextService> {
  return defineTool<FileSystem.FileSystem | FileSystemContextService, CreatePdfArgs>({
    name: "create_pdf",
    disclosure: "internal",
    description:
      "Render a PDF from HTML you write, saved to the user's working directory (or an explicit path). " +
      "Use for reports, summaries, invoices, or anything the person will keep, print, or send on. " +
      "The text and numbers are exactly what you write — this is a renderer, not an image generator. " +
      "Needs Chrome or Chromium installed (or PUPPETEER_EXECUTABLE_PATH set).",
    tags: ["document", "pdf"],
    parameters: createPdfParameters,
    riskLevel: "low-risk",
    validate: makeZodValidator(createPdfParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const executablePath = yield* Effect.tryPromise({
          try: () => resolveBrowserExecutablePath(browserLookup()),
          catch: () => new Error(MISSING_BROWSER_FOR_PDF_ERROR),
        });
        if (executablePath === null) {
          return yield* Effect.fail(new Error(MISSING_BROWSER_FOR_PDF_ERROR));
        }

        const workingDirectory = yield* resolveWorkingDirectory(context);
        const pdfPath = resolvePdfOutputPath(args, workingDirectory);

        // Chromium loads the source over file://, so the HTML has to exist on disk. It goes next
        // to the PDF rather than in a temp dir so a broken render leaves something inspectable.
        const htmlPath = `${pdfPath}.source.html`;
        yield* fs.writeFileString(htmlPath, args.html);

        yield* Effect.tryPromise({
          try: () =>
            renderPdf(htmlPath, pdfPath, executablePath, {
              landscape: args.landscape ?? false,
              format: args.format ?? "A4",
            }),
          catch: (error) =>
            new Error(
              `Failed to render PDF: ${error instanceof Error ? error.message : String(error)}`,
            ),
        });
        yield* fs.remove(htmlPath).pipe(Effect.catchAll(() => Effect.void));

        const artifact: GeneratedArtifact = {
          kind: "pdf",
          path: pdfPath,
          mediaType: "application/pdf",
          title: args.title,
          tool: "create_pdf",
          source: "rendered",
        };

        return {
          success: true,
          result: { path: pdfPath, title: args.title, artifacts: [artifact] },
          artifacts: [artifact],
        } satisfies ToolExecutionResult;
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            success: false,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ToolExecutionResult),
        ),
      ),
    createSummary: (result) => {
      if (!result.success) return undefined;
      const data = result.result as { path: string };
      return `Wrote ${data.path}`;
    },
  });
}

/**
 * The agent's tracked working directory, falling back to the process cwd.
 *
 * The agent can `cd` mid-session, so a relative output path has to resolve against where the
 * agent believes it is, not where jazz was launched.
 */
function resolveWorkingDirectory(
  context: ToolExecutionContext,
): Effect.Effect<string, never, FileSystemContextService> {
  return Effect.gen(function* () {
    const shell = yield* FileSystemContextServiceTag;
    const cwd = yield* shell
      .getCwd(buildKeyFromContext(context))
      .pipe(Effect.catchAll(() => Effect.succeed(process.cwd())));
    return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
  });
}
