import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { testConfigLayer } from "@/core/agent/test-config";
import type { ToolExecutionContext } from "@/core/types/tools";
import {
  type BrowserExecutableLookup,
  compositionFilenameFromTitle,
  createCompositionTool,
  MISSING_BROWSER_ERROR,
  resolveBrowserExecutablePath,
  withFavicon,
} from "./composition";

const context: ToolExecutionContext = { agentId: "agent-1" };

const MINIMAL_HTML = "<html><body>hi</body></html>";

function lookupWithChannels(
  installed: Readonly<Record<string, string>>,
  configuredExecutablePath?: string,
): BrowserExecutableLookup & { readonly probedChannels: string[] } {
  const probedChannels: string[] = [];
  return {
    probedChannels,
    configuredExecutablePath,
    findSystemChrome: async (channel) => {
      probedChannels.push(channel);
      return installed[channel] ?? null;
    },
  };
}
describe("withFavicon", () => {
  test("injects an inline SVG favicon into the head when none is declared", () => {
    const out = withFavicon("<html><head><title>x</title></head><body>hi</body></html>");
    expect(out).toContain('<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,');
    expect(out).not.toContain(".ico");
    expect(out.indexOf('<link rel="icon"')).toBeLessThan(out.indexOf("</head>"));
  });

  test("leaves the document untouched when it already declares an icon", () => {
    const html =
      '<html><head><link rel="icon" href="data:image/svg+xml,%3Csvg/%3E" /></head><body>hi</body></html>';
    expect(withFavicon(html)).toBe(html);
  });

  test("recognizes single-quoted rel and shortcut icon variants", () => {
    const single = withFavicon(
      "<html><head><link rel='icon' href='a.svg' /></head><body>b</body></html>",
    );
    expect(single).not.toContain("data:image/svg+xml,%3Csvg");
    const shortcut = withFavicon(
      '<html><head><link rel="shortcut icon" href="a.ico" /></head><body>b</body></html>',
    );
    expect(shortcut).toContain('href="a.ico"');
    expect(shortcut).not.toContain("data:image/svg+xml,%3Csvg");
  });

  test("falls back to before </html> when there is no head tag", () => {
    const out = withFavicon("<html><body>hi</body></html>");
    expect(out).toContain('rel="icon"');
    expect(out.endsWith("</html>")).toBe(true);
  });

  test("appends the link for bare fragments and keeps the default decodable", () => {
    const out = withFavicon("<div>hi</div>");
    expect(out).toContain('rel="icon"');
    const m = out.match(/data:image\/svg\+xml,([^"'\s]+)/);
    const uri = m?.[1];
    expect(uri).toBeDefined();
    if (uri !== undefined) {
      expect(decodeURIComponent(uri)).toContain("<svg");
      expect(decodeURIComponent(uri)).toContain("</svg>");
    }
  });
});

function runTool(tool: ReturnType<typeof createCompositionTool>, args: Record<string, unknown>) {
  return Effect.runPromise(
    tool
      .execute(args, context)
      .pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, testConfigLayer()))),
  );
}

describe("resolveBrowserExecutablePath", () => {
  test("prefers PUPPETEER_EXECUTABLE_PATH over any installed channel", async () => {
    const lookup = lookupWithChannels({ chrome: "/system/chrome" }, "/usr/bin/chromium");

    expect(await resolveBrowserExecutablePath(lookup)).toBe("/usr/bin/chromium");
    expect(lookup.probedChannels).toEqual([]);
  });

  test("falls back through the release channels in order", async () => {
    const lookup = lookupWithChannels({ "chrome-dev": "/system/chrome-dev" });

    expect(await resolveBrowserExecutablePath(lookup)).toBe("/system/chrome-dev");
    expect(lookup.probedChannels).toEqual(["chrome", "chrome-beta", "chrome-dev"]);
  });

  test("ignores a blank PUPPETEER_EXECUTABLE_PATH instead of launching an empty path", async () => {
    const lookup = lookupWithChannels({ chrome: "/system/chrome" }, "   ");

    expect(await resolveBrowserExecutablePath(lookup)).toBe("/system/chrome");
  });

  test("returns null when nothing is configured and no channel is installed", async () => {
    expect(await resolveBrowserExecutablePath(lookupWithChannels({}))).toBeNull();
  });
});

describe("create_composition without a browser", () => {
  const jazzHome = mkdtempSync(join(tmpdir(), "jazz-composition-"));
  let previousJazzHome: string | undefined;

  beforeAll(() => {
    previousJazzHome = process.env["JAZZ_HOME"];
    process.env["JAZZ_HOME"] = jazzHome;
  });

  afterAll(() => {
    if (previousJazzHome === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = previousJazzHome;
    rmSync(jazzHome, { recursive: true, force: true });
  });

  test("static mode fails with an actionable error, not a puppeteer crash", async () => {
    const tool = createCompositionTool(() => lookupWithChannels({}));

    const result = await runTool(tool, {
      html: MINIMAL_HTML,
      title: "Chart",
      mode: "static",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe(MISSING_BROWSER_ERROR);
    expect(result.error).toContain("PUPPETEER_EXECUTABLE_PATH");
    expect(result.error).toContain("Chromium");
  });

  test("interactive mode still succeeds and never looks for a browser", async () => {
    const lookup = lookupWithChannels({});
    const tool = createCompositionTool(() => lookup);

    const result = await runTool(tool, {
      html: MINIMAL_HTML,
      title: "Dashboard",
      mode: "interactive",
    });

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ mode: "interactive", title: "Dashboard" });
    expect(result.result).toMatchObject({
      htmlPath: `${jazzHome}/compositions/agent-1/dashboard.html`,
    });
    expect(result.artifacts).toMatchObject([
      { kind: "html", tool: "create_composition", source: "rendered" },
    ]);
    expect(lookup.probedChannels).toEqual([]);
  });

  test("uses the actual conversation id as the composition session directory", async () => {
    const tool = createCompositionTool(() => lookupWithChannels({}));
    const sessionContext: ToolExecutionContext = {
      agentId: "agent-1",
      conversationId: "session: with punctuation",
    };

    const result = await Effect.runPromise(
      tool
        .execute(
          { html: MINIMAL_HTML, title: "Session composition", mode: "interactive" },
          sessionContext,
        )
        .pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, testConfigLayer()))),
    );

    expect(result.result).toMatchObject({
      sessionId: "session--with-punctuation-7fe19d9b",
      htmlPath: `${jazzHome}/compositions/session--with-punctuation-7fe19d9b/session-composition.html`,
    });
  });

  test("keeps the old tool name as a configuration-only alias", () => {
    expect(createCompositionTool().aliases).toEqual(["create_web_app"]);
  });

  test("keeps repeated composition names instead of overwriting them", async () => {
    const tool = createCompositionTool(() => lookupWithChannels({}));
    const args = { html: MINIMAL_HTML, title: "Repeated", mode: "interactive" };

    const first = await runTool(tool, args);
    const second = await runTool(tool, args);

    expect(first.result).toMatchObject({
      htmlPath: `${jazzHome}/compositions/agent-1/repeated.html`,
    });
    expect(second.result).toMatchObject({
      htmlPath: `${jazzHome}/compositions/agent-1/repeated-2.html`,
    });
  });
});

describe("create_composition htmlPath source", () => {
  const jazzHome = mkdtempSync(join(tmpdir(), "jazz-composition-path-"));
  const sourceDir = mkdtempSync(join(tmpdir(), "jazz-composition-src-"));
  let previousJazzHome: string | undefined;

  beforeAll(() => {
    previousJazzHome = process.env["JAZZ_HOME"];
    process.env["JAZZ_HOME"] = jazzHome;
  });

  afterAll(() => {
    if (previousJazzHome === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = previousJazzHome;
    rmSync(jazzHome, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  test("reads the document from an existing file and preserves its content", async () => {
    const sourcePath = join(sourceDir, "page.html");
    writeFileSync(sourcePath, "<html><body>from disk</body></html>", "utf8");
    const tool = createCompositionTool(() => lookupWithChannels({}));

    const result = await runTool(tool, {
      htmlPath: sourcePath,
      title: "From path",
      mode: "interactive",
    });

    expect(result.success).toBe(true);
    const saved = result.result as { htmlPath: string };
    const content = readFileSync(saved.htmlPath, "utf8");
    expect(content).toContain("from disk");
    expect(content).toContain('<link rel="icon" type="image/svg+xml"');
  });

  test("resolves a relative path against the process cwd when no fs context exists", async () => {
    const sourcePath = join(sourceDir, "rel.html");
    writeFileSync(sourcePath, "<html><body>relative</body></html>", "utf8");
    const previousCwd = process.cwd();
    process.chdir(sourceDir);
    try {
      const tool = createCompositionTool(() => lookupWithChannels({}));
      const result = await runTool(tool, {
        htmlPath: "rel.html",
        title: "Relative",
        mode: "interactive",
      });
      expect(result.success).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("fails with an actionable error when the file does not exist", async () => {
    const tool = createCompositionTool(() => lookupWithChannels({}));

    const result = await runTool(tool, {
      htmlPath: join(sourceDir, "missing.html"),
      title: "Missing",
      mode: "interactive",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not exist");
    expect(result.error).toContain("Write the document to a file first");
  });

  test("fails when both html and htmlPath are provided", async () => {
    const tool = createCompositionTool(() => lookupWithChannels({}));

    const result = await runTool(tool, {
      html: MINIMAL_HTML,
      htmlPath: join(sourceDir, "any.html"),
      title: "Both",
      mode: "interactive",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("both html and htmlPath");
  });

  test("fails when neither html nor htmlPath is provided", async () => {
    const tool = createCompositionTool(() => lookupWithChannels({}));

    const result = await runTool(tool, { title: "Neither", mode: "interactive" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("pass html, or htmlPath");
  });
});

describe("compositionFilenameFromTitle", () => {
  test("makes a portable readable filename", () => {
    expect(compositionFilenameFromTitle("Weekly spending #1")).toBe("weekly-spending-1.html");
    expect(compositionFilenameFromTitle("???")).toBe("composition.html");
  });
});
