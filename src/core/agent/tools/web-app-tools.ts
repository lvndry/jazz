import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import puppeteer, { type ChromeReleaseChannel } from "puppeteer-core";
import shortuuid from "short-uuid";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { GeneratedArtifact } from "@/core/types/artifact";
import type { ToolExecutionResult } from "@/core/types/tools";
import { getUserDataDirectory } from "@/core/utils/paths";
import { defineTool, makeZodValidator } from "./base-tool";

/**
 * Lets the agent produce arbitrary interactive UI — not just charts, any
 * self-contained webpage (a form, a dashboard, a small game, an explorable
 * chart) — for surfaces that can render it as a Telegram Web App / Mini App.
 *
 * The agent writes the whole HTML document itself (inline CSS/JS, CDN
 * scripts for libraries like Chart.js are fine since the page runs in a real
 * WebView with network access). This tool only persists it and, for "static"
 * mode, rasterizes it once via a headless browser so it can be delivered as a
 * plain chat image with no tap required.
 *
 * Surface-specific delivery (serving the interactive HTML over a public URL,
 * or posting the static image) is the caller's job — e.g. the Telegram
 * bridge reads this tool's structured result off `AgentResponse.toolResults`.
 *
 * "static" mode needs a Chrome/Chromium on the host. Jazz depends on
 * `puppeteer-core`, which ships no browser, so that a global `npm i -g jazz-ai`
 * never pays for a ~150MB Chrome download nobody asked for. "interactive" mode
 * needs no browser at all.
 */

function getWebAppsDirectory(): string {
  return `${getUserDataDirectory()}/webapps`;
}

/** Tried in order when `PUPPETEER_EXECUTABLE_PATH` is unset. */
const CHROME_RELEASE_CHANNELS: readonly ChromeReleaseChannel[] = [
  "chrome",
  "chrome-beta",
  "chrome-dev",
  "chrome-canary",
];

export const MISSING_BROWSER_ERROR =
  "create_web_app with mode 'static' needs a Chrome or Chromium install to screenshot the page, " +
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

const createWebAppParameters = z
  .object({
    html: z
      .string()
      .min(1)
      .describe(
        "A complete, self-contained HTML document (<!doctype html> optional, but include " +
          "<html>/<head>/<body>). Inline all CSS/JS; CDN <script>/<link> tags are fine. Don't " +
          "reference local files — the page must render correctly with nothing but this string.",
      ),
    title: z
      .string()
      .min(1)
      .max(120)
      .describe("Short title for this UI — used as the button label / display name."),
    mode: z
      .enum(["static", "interactive"])
      .describe(
        "'static': render once to a PNG image delivered directly in the chat, no tap needed — " +
          "use for a quick chart, diagram, or anything that doesn't need input or motion. " +
          "'interactive': the person taps a button to open the live page — use when it needs " +
          "hover/zoom/filter, form input, or is a game/tool they interact with.",
      ),
    width: z
      .number()
      .int()
      .min(200)
      .max(2000)
      .optional()
      .describe("Viewport width in pixels for 'static' rendering (default: 800)."),
    height: z
      .number()
      .int()
      .min(200)
      .max(2000)
      .optional()
      .describe("Viewport height in pixels for 'static' rendering (default: 600)."),
  })
  .strict();

type CreateWebAppArgs = z.infer<typeof createWebAppParameters>;

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

export function createWebAppTool(
  browserLookup: () => BrowserExecutableLookup = createSystemBrowserLookup,
): Tool<FileSystem.FileSystem> {
  return defineTool<FileSystem.FileSystem, CreateWebAppArgs>({
    name: "create_web_app",
    disclosure: "internal",
    description:
      "Create a UI — a chart, form, dashboard, small game, or any other webpage — and deliver it as a static image (mode: 'static') or a live page (mode: 'interactive'). " +
      "Use this when a plain text or markdown answer is the wrong medium. You write the full HTML yourself. " +
      "mode 'static' needs Chrome or Chromium installed (or PUPPETEER_EXECUTABLE_PATH set). " +
      "mode 'interactive' opens as a Mini App or WebView on Telegram and Discord; in the terminal it only writes a local HTML file. Do not use this to fetch or search the web.",
    tags: ["ui", "webapp"],
    parameters: createWebAppParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(createWebAppParameters),
    handler: (args, _context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = getWebAppsDirectory();
        yield* fs.makeDirectory(dir, { recursive: true });

        const id = shortuuid.generate();
        const htmlPath = `${dir}/${id}.html`;
        yield* fs.writeFileString(htmlPath, args.html);

        if (args.mode === "interactive") {
          return {
            success: true,
            result: {
              id,
              mode: "interactive",
              title: args.title,
              htmlPath,
            },
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
          tool: "create_web_app",
          source: "rendered",
        };

        return {
          success: true,
          result: {
            id,
            mode: "static",
            title: args.title,
            htmlPath,
            imagePath: pngPath,
            artifacts: [artifact],
          },
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
      const data = result.result as { mode: string; title: string };
      return `Created ${data.mode} web app: ${data.title}`;
    },
  });
}
