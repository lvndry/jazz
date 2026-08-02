import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import shortuuid from "short-uuid";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types/tools";
import { getUserDataDirectory } from "@/core/utils/runtime-detection";
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
 */

function getWebAppsDirectory(): string {
  return `${getUserDataDirectory()}/webapps`;
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
): Promise<void> {
  const { default: puppeteer } = await import("puppeteer");
  const browser = await puppeteer.launch({
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

export function createWebAppTool(): Tool<FileSystem.FileSystem> {
  return defineTool<FileSystem.FileSystem, CreateWebAppArgs>({
    name: "create_web_app",
    description:
      "Create an interactive UI — a chart, form, dashboard, small game, or any other webpage — " +
      "for delivery back to the person as either a static image (mode: static) or a live, " +
      "tappable page (mode: interactive). Use this whenever a plain text/markdown answer " +
      "genuinely isn't the right medium for the request (e.g. 'show me a chart', 'make an " +
      "interactive UI for X'). You write the full HTML yourself.",
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

        yield* Effect.tryPromise({
          try: () => renderStaticScreenshot(htmlPath, pngPath, width, height),
          catch: (error) =>
            new Error(
              `Failed to render static web app: ${error instanceof Error ? error.message : String(error)}`,
            ),
        });

        return {
          success: true,
          result: {
            id,
            mode: "static",
            title: args.title,
            htmlPath,
            imagePath: pngPath,
          },
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
