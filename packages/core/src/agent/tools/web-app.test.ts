import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { ToolExecutionContext } from "@/core/types/tools";
import {
  type BrowserExecutableLookup,
  compositionFilenameFromTitle,
  createCompositionTool,
  MISSING_BROWSER_ERROR,
  resolveBrowserExecutablePath,
} from "./web-app";

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

function runTool(tool: ReturnType<typeof createCompositionTool>, args: Record<string, unknown>) {
  return Effect.runPromise(tool.execute(args, context).pipe(Effect.provide(NodeFileSystem.layer)));
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
  const jazzHome = mkdtempSync(join(tmpdir(), "jazz-web-app-"));
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
        .pipe(Effect.provide(NodeFileSystem.layer)),
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

describe("compositionFilenameFromTitle", () => {
  test("makes a portable readable filename", () => {
    expect(compositionFilenameFromTitle("Weekly spending #1")).toBe("weekly-spending-1.html");
    expect(compositionFilenameFromTitle("???")).toBe("composition.html");
  });
});
