import { isAbsolute, join } from "node:path";
import { Effect, FileSystem, Option } from "effect";
import puppeteer, { type ChromeReleaseChannel } from "puppeteer-core";
import shortuuid from "short-uuid";
import { z } from "zod";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import { FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { KnownSecret } from "@/core/secrets/redaction";
import type { GeneratedArtifact } from "@/core/types/artifact";
import type { ToolExecutionContext } from "@/core/types/tools";
import type { ToolExecutionResult } from "@/core/types/tools";
import { toError } from "@/core/utils/errors";
import { getUserDataDirectory } from "@/core/utils/paths";
import { stateDirectoryMode, stateFileMode } from "@/core/utils/private-mode";
import { storageSafeSegment } from "@/core/utils/storage-id";
import { defineTool, makeZodValidator } from "./base-tool";
import { CHROME_RELEASE_CHANNELS } from "./chromium-default";
import { openCompletedCompositionInBrowser } from "./composition-browser";
import { type EgressPolicy, egressPolicyForContext } from "./guarded-fetch";
import { guardPageRequests } from "./guarded-page";
import { toolKnownSecrets } from "./tool-secrets";

/**
 * Lets the agent compose a polished visual artifact — not just charts, any
 * self-contained webpage (a form, dashboard, small game, or explorable chart)
 * — for the terminal and chat surfaces that can present it.
 *
 * The agent supplies the complete HTML document itself (inline CSS/JS, CDN
 * scripts for libraries like Chart.js are fine since the page runs in a real
 * WebView with network access), either as the `html` argument for small
 * one-shot documents or as `htmlPath` pointing at a file the agent already
 * wrote — the preferred path for large or iterated pages, since the document
 * then only exists on disk once instead of being re-emitted in full in every
 * tool call. This tool only persists it and, for "static" mode, rasterizes it
 * once via a headless browser so it can be delivered as a plain chat image
 * with no tap required.
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
      .optional()
      .describe(
        "Complete self-contained HTML document with <html>/<head>/<body>. Inline CSS/JS; CDN <script>/<link> tags are fine; reference no local files. " +
          "For small one-shot documents. Pass exactly one of html or htmlPath.",
      ),
    htmlPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Path to a complete HTML document you already wrote to disk, absolute or relative to the working directory. " +
          "Prefer this for large or iterated pages: edit the file and re-call the tool instead of re-sending the whole document. " +
          "Pass exactly one of html or htmlPath.",
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

/**
 * Resolve the caller's HTML source: either the inline `html` document or the
 * file at `htmlPath` (absolute, or relative to the session working directory).
 * Exactly one of the two must be provided — the schema keeps both optional so
 * the error message can name both arguments, so the invariant is enforced here.
 */
function resolveHtmlSource(
  fs: FileSystem.FileSystem,
  args: CreateCompositionArgs,
  context: ToolExecutionContext,
) {
  const hasHtml = args.html !== undefined;
  const hasPath = args.htmlPath !== undefined;
  if (hasHtml === hasPath) {
    return Effect.fail(
      new Error(
        hasHtml
          ? "create_composition received both html and htmlPath. Pass exactly one of them."
          : "create_composition needs the HTML document: pass html, or htmlPath pointing at a file you already wrote.",
      ),
    );
  }
  if (hasHtml) return Effect.succeed(args.html as string);
  const rawPath = args.htmlPath as string;
  return Effect.gen(function* () {
    const fileSystemContext = yield* Effect.serviceOption(FileSystemContextServiceTag);
    const workingDirectory = Option.isSome(fileSystemContext)
      ? yield* fileSystemContext.value.getCwd({
          agentId: context.agentId,
          ...(context.conversationId !== undefined
            ? { conversationId: context.conversationId }
            : {}),
        })
      : process.cwd();
    const resolvedPath = isAbsolute(rawPath) ? rawPath : join(workingDirectory, rawPath);
    const exists = yield* fs.exists(resolvedPath);
    if (!exists) {
      return yield* Effect.fail(
        new Error(
          `create_composition: htmlPath does not exist: ${resolvedPath}. Write the document to a file first and pass that file's path instead.`,
        ),
      );
    }
    const stats = yield* fs.stat(resolvedPath);
    if (stats.type !== "File") {
      return yield* Effect.fail(
        new Error(`create_composition: htmlPath is not a regular file: ${resolvedPath}`),
      );
    }
    const text = yield* fs.readFileString(resolvedPath);
    if (text.length === 0) {
      return yield* Effect.fail(
        new Error(`create_composition: htmlPath is an empty file: ${resolvedPath}`),
      );
    }
    return text;
  });
}
type CreateCompositionArgs = z.infer<typeof createCompositionParameters>;

/** A neutral mark the browser can show in the tab: a ringed dot on a dark tile. */
const DEFAULT_FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0d1428"/><circle cx="16" cy="16" r="7.5" fill="none" stroke="#6fc0ff" stroke-width="2.4"/><circle cx="24.5" cy="7.5" r="2.4" fill="#ffd08a"/></svg>',
  );

const FAVICON_LINK_TAG = `<link rel="icon" type="image/svg+xml" href="${DEFAULT_FAVICON}" />`;

/** True when the document already declares a favicon of any kind. */
function hasFaviconLink(html: string): boolean {
  return (
    /<link\b[^>]*\brel\s*=\s*["'][^"']*(?:shortcut\s+)?icon/i.test(html) ||
    /<link\b[^>]*\brel\s*=\s*["'][^"']*apple-touch-icon/i.test(html)
  );
}

/**
 * Every composition page gets a favicon, so tabs and browser previews never
 * fall back to the generic globe. Documents that already declare one (any
 * `rel="icon"` or `apple-touch-icon` link) pass through untouched; everything
 * else gets an inline SVG data-URI default — no extra file, works on file://.
 * The agent is still expected to design its own themed favicon; this is the
 * safety net. Exported for tests; the handler applies it to both inline and
 * htmlPath input.
 */
export function withFavicon(html: string): string {
  if (hasFaviconLink(html)) return html;
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch && headMatch.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length;
    return html.slice(0, insertAt) + "\n" + FAVICON_LINK_TAG + html.slice(insertAt);
  }
  const closeHtml = html.toLowerCase().lastIndexOf("</html>");
  if (closeHtml !== -1) return html.slice(0, closeHtml) + FAVICON_LINK_TAG + html.slice(closeHtml);
  return html + FAVICON_LINK_TAG;
}

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
  policy: EgressPolicy,
  known: readonly KnownSecret[],
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
    await guardPageRequests(page, htmlPath, policy, known);
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0" });
    await page.screenshot({ path: pngPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

export function createCompositionTool(
  browserLookup: () => BrowserExecutableLookup = createSystemBrowserLookup,
): Tool<FileSystem.FileSystem | AgentConfigService> {
  return defineTool<FileSystem.FileSystem | AgentConfigService, CreateCompositionArgs>({
    name: "create_composition",
    disclosure: "internal",
    summary:
      "Compose a visual artifact: chart, visualization, diagram, interactive explainer, dashboard, form or tool.",
    description:
      "Build a polished visual artifact when a visual is clearer than text. Make it finished: semantic HTML, a <title>, and an inline SVG data-URI favicon, responsive from 320px, clear labels and units, " +
      "accessible contrast and focus, keyboard-operable, reduced-motion friendly. Use only real data at its real precision. Inline CSS/JS; add a library only when it clearly helps. " +
      "For small documents pass html directly; for large or iterated pages write the document to a file first, pass htmlPath, and re-call after editing the file instead of re-sending the whole document. " +
      "A 'static' render must be legible with no hover, click or scroll, and needs Chrome " +
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
        yield* fs.makeDirectory(dir, { recursive: true, mode: stateDirectoryMode() });

        const id = shortuuid.generate();
        const html = withFavicon(yield* resolveHtmlSource(fs, args, context));
        const htmlPath = yield* nextCompositionPath(fs, dir, args.title);
        const filename = htmlPath.slice(dir.length + 1);
        yield* fs.writeFileString(htmlPath, html, { mode: stateFileMode() });

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

        const egressPolicy = yield* egressPolicyForContext(context);
        const known = yield* toolKnownSecrets();
        yield* Effect.tryPromise({
          try: () =>
            renderStaticScreenshot(
              htmlPath,
              pngPath,
              width,
              height,
              executablePath,
              egressPolicy,
              known,
            ),
          catch: (error) => new Error(`Failed to render static web app: ${toError(error).message}`),
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
        Effect.catch((error) =>
          Effect.succeed({
            success: false,
            result: null,
            error: toError(error).message,
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
