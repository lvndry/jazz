import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import puppeteer, { type ChromeReleaseChannel } from "puppeteer-core";
import shortuuid from "short-uuid";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { GeneratedArtifact } from "@/core/types/artifact";
import type { ToolExecutionResult } from "@/core/types/tools";
import { getUserDataDirectory } from "@/core/utils/paths";
import { storageSafeSegment } from "@/core/utils/storage-id";
import { defineTool, makeZodValidator } from "./base-tool";
import { openCompletedCompositionInBrowser } from "./composition-browser";

/**
 * Lets the agent compose a polished visual artifact — not just charts, any
 * self-contained webpage (a form, dashboard, small game, or explorable chart)
 * — for the terminal and chat surfaces that can present it.
 *
 * The agent writes the whole HTML document itself (inline CSS/JS, CDN
 * scripts for libraries like Chart.js are fine since the page runs in a real
 * WebView with network access). This tool only persists it and, for "static"
 * mode, rasterizes it once via a headless browser so it can be delivered as a
 * plain chat image with no tap required.
 *
 * Surface-specific delivery (serving the interactive HTML over a public URL,
 * posting the static image, or opening a local browser) is the caller's job.
 *
 * "static" mode needs a Chrome/Chromium on the host. Jazz depends on
 * `puppeteer-core`, which ships no browser, so that a global `npm i -g jazz-ai`
 * never pays for a ~150MB Chrome download nobody asked for. "interactive" mode
 * needs no browser at all.
 */

function getCompositionsDirectory(sessionId: string): string {
  return `${getUserDataDirectory()}/compositions/${storageSafeSegment(sessionId)}`;
}

/** Tried in order when `PUPPETEER_EXECUTABLE_PATH` is unset. */
const CHROME_RELEASE_CHANNELS: readonly ChromeReleaseChannel[] = [
  "chrome",
  "chrome-beta",
  "chrome-dev",
  "chrome-canary",
];

export const MISSING_BROWSER_ERROR =
  "create_composition with mode 'static' needs a Chrome or Chromium install to screenshot the page, " +
  "and none was found. Install Google Chrome or Chromium, or point PUPPETEER_EXECUTABLE_PATH at " +
  "an existing browser binary. Retrying with mode 'interactive' needs no browser.";

export interface BrowserExecutableLookup {
  /** Value of `PUPPETEER_EXECUTABLE_PATH`, honoured verbatim and never probed. */
  readonly configuredExecutablePath: string | undefined;
  /** Resolves an installed Chrome for a release channel, or `null` if absent. */
  readonly findSystemChrome: (channel: ChromeReleaseChannel) => Promise<string | null>;
}

/**
 * An explicit `PUPPETEER_EXECUTABLE_PATH` wins outright — it is how containers
 * and airgapped hosts point at a system Chromium that no release channel finds.
 */
export async function resolveBrowserExecutablePath(
  lookup: BrowserExecutableLookup,
): Promise<string | null> {
  const configuredExecutablePath = lookup.configuredExecutablePath?.trim();
  if (configuredExecutablePath !== undefined && configuredExecutablePath.length > 0) {
    return configuredExecutablePath;
  }

  for (const channel of CHROME_RELEASE_CHANNELS) {
    const systemChrome = await lookup.findSystemChrome(channel);
    if (systemChrome !== null) return systemChrome;
  }

  return null;
}

export function createSystemBrowserLookup(): BrowserExecutableLookup {
  return {
    configuredExecutablePath: process.env["PUPPETEER_EXECUTABLE_PATH"],
    findSystemChrome: async (channel) => {
      try {
        return await puppeteer.executablePath(channel);
      } catch {
        return null;
      }
    },
  };
}

const createCompositionParameters = z
  .object({
    html: z
      .string()
      .min(1)
      .describe(
        "Complete self-contained HTML document with <html>/<head>/<body>. Inline CSS/JS; CDN <script>/<link> tags are fine; reference no local files.",
      ),
    title: z
      .string()
      .min(1)
      .max(120)
      .describe("Short display title and filename, a concrete noun phrase like 'weekly-spending'."),
    mode: z
      .enum(["static", "interactive"])
      .describe(
        "'static': one PNG in the chat, for a chart or diagram needing no input or motion. " +
          "'interactive': a live page the person opens, for hover, filters, forms or games.",
      ),
    width: z
      .number()
      .int()
      .min(200)
      .max(2000)
      .optional()
      .describe("Viewport width in px for 'static' (default 800)."),
    height: z
      .number()
      .int()
      .min(200)
      .max(2000)
      .optional()
      .describe("Viewport height in px for 'static' (default 600)."),
  })
  .strict();

type CreateCompositionArgs = z.infer<typeof createCompositionParameters>;

/** A readable, portable filename based on the composition's display name. */
export function compositionFilenameFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug.length > 0 ? slug : "composition"}.html`;
}

/**
 * Preserve every composition in a session. Repeating a title gets a readable
 * numeric suffix rather than silently replacing an earlier artifact.
 */
function nextCompositionPath(fs: FileSystem.FileSystem, directory: string, title: string) {
  const filename = compositionFilenameFromTitle(title);
  const extensionIndex = filename.lastIndexOf(".");
  const stem = filename.slice(0, extensionIndex);
  const extension = filename.slice(extensionIndex);

  return Effect.gen(function* () {
    for (let version = 1; ; version += 1) {
      const candidate = `${directory}/${stem}${version === 1 ? "" : `-${version}`}${extension}`;
      if (!(yield* fs.exists(candidate))) return candidate;
    }
  });
}

async function renderStaticScreenshot(
  htmlPath: string,
  pngPath: string,
  width: number,
  height: number,
  executablePath: string,
): Promise<void> {
  const browser = await puppeteer.launch({
    browser: "chrome",
    executablePath,
    headless: true,
    // --no-sandbox: Chromium's sandbox needs kernel privileges most
    // containers don't grant; harmless outside a container too.
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0" });
    await page.screenshot({ path: pngPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

export function createCompositionTool(
  browserLookup: () => BrowserExecutableLookup = createSystemBrowserLookup,
): Tool<FileSystem.FileSystem> {
  return defineTool<FileSystem.FileSystem, CreateCompositionArgs>({
    name: "create_composition",
    disclosure: "internal",
    summary:
      "Compose a visual artifact: chart, visualization, diagram, interactive explainer, dashboard, form or tool.",
    description:
      "Build a polished visual artifact when a visual is clearer than text. Make it finished: semantic HTML, responsive from 320px, clear labels and units, " +
      "accessible contrast and focus, keyboard-operable, reduced-motion friendly. Use only real data at its real precision. Inline CSS/JS; add a library only when it clearly helps. A 'static' render must be legible with no hover, click or scroll, and needs Chrome " +
      "or Chromium (or PUPPETEER_EXECUTABLE_PATH). An 'interactive' page must be useful on its first screen without instructions.",
    tags: ["ui", "visualization", "composition"],
    // Existing agent configurations can keep working while the model sees and
    // calls the new, better-named capability.
    aliases: ["create_web_app"],
    parameters: createCompositionParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(createCompositionParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sessionId = storageSafeSegment(context.conversationId ?? context.agentId);
        const dir = getCompositionsDirectory(sessionId);
        yield* fs.makeDirectory(dir, { recursive: true });

        const id = shortuuid.generate();
        const htmlPath = yield* nextCompositionPath(fs, dir, args.title);
        const filename = htmlPath.slice(dir.length + 1);
        yield* fs.writeFileString(htmlPath, args.html);

        const htmlArtifact: GeneratedArtifact = {
          kind: "html",
          path: htmlPath,
          mediaType: "text/html",
          title: args.title,
          tool: "create_composition",
          source: "rendered",
        };

        if (args.mode === "interactive") {
          const opened = yield* Effect.promise(() => openCompletedCompositionInBrowser(htmlPath));
          return {
            success: true,
            result: {
              id,
              mode: "interactive",
              title: args.title,
              sessionId,
              filename,
              htmlPath,
              ...(opened ? { opened: true } : {}),
            },
            artifacts: [htmlArtifact],
          } satisfies ToolExecutionResult;
        }

        const pngPath = `${dir}/${id}.png`;
        const width = args.width ?? 800;
        const height = args.height ?? 600;

        const executablePath = yield* Effect.tryPromise({
          try: () => resolveBrowserExecutablePath(browserLookup()),
          catch: () => new Error(MISSING_BROWSER_ERROR),
        });
        if (executablePath === null) {
          return yield* Effect.fail(new Error(MISSING_BROWSER_ERROR));
        }

        yield* Effect.tryPromise({
          try: () => renderStaticScreenshot(htmlPath, pngPath, width, height, executablePath),
          catch: (error) =>
            new Error(
              `Failed to render static web app: ${error instanceof Error ? error.message : String(error)}`,
            ),
        });

        // `source: "rendered"`, emphatically: this PNG is a screenshot of HTML the model wrote,
        // so its numbers and labels are exact. Labelling it alongside AI-generated imagery would
        // tell the reader not to trust figures they can trust.
        const artifact: GeneratedArtifact = {
          kind: "image",
          path: pngPath,
          mediaType: "image/png",
          title: args.title,
          tool: "create_composition",
          source: "rendered",
        };
        const opened = yield* Effect.promise(() => openCompletedCompositionInBrowser(htmlPath));

        return {
          success: true,
          result: {
            id,
            mode: "static",
            title: args.title,
            sessionId,
            filename,
            htmlPath,
            ...(opened ? { opened: true } : {}),
            imagePath: pngPath,
            artifacts: [htmlArtifact, artifact],
          },
          artifacts: [htmlArtifact, artifact],
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
      const data = result.result as { mode: string; title: string };
      return `Created ${data.mode} composition: ${data.title}`;
    },
  });
}
