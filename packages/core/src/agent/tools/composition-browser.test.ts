import { describe, expect, test } from "bun:test";
import {
  openCompletedCompositionInBrowser,
  shouldOpenCompletedComposition,
  type CompositionBrowserContext,
  type CompositionBrowserLauncher,
} from "./composition-browser";

function context(overrides: Partial<CompositionBrowserContext> = {}): CompositionBrowserContext {
  return {
    platform: "darwin",
    env: {},
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    ...overrides,
  };
}

function recordingLauncher(): CompositionBrowserLauncher & {
  readonly calls: [string, string[]][];
} {
  const calls: [string, string[]][] = [];
  return {
    calls,
    launch: async (command, args) => {
      calls.push([command, [...args]]);
    },
  };
}

describe("shouldOpenCompletedComposition", () => {
  test("allows an interactive local CLI", () => {
    expect(shouldOpenCompletedComposition(context())).toBe(true);
  });

  test("does not open a browser in CI, even if a runner has a TTY", () => {
    expect(shouldOpenCompletedComposition(context({ env: { CI: "true" } }))).toBe(false);
  });

  test("does not open a browser for a bridge surface", () => {
    expect(shouldOpenCompletedComposition(context({ env: { JAZZ_SURFACE: "telegram" } }))).toBe(
      false,
    );
  });

  test("does not open a browser without an attached terminal", () => {
    expect(
      shouldOpenCompletedComposition(
        context({ stdin: { isTTY: false }, stdout: { isTTY: false } }),
      ),
    ).toBe(false);
  });
});

describe("openCompletedCompositionInBrowser", () => {
  test("uses the platform opener with a safely encoded file URL", async () => {
    const launcher = recordingLauncher();

    await expect(
      openCompletedCompositionInBrowser("/tmp/My composition #1.html", context(), launcher),
    ).resolves.toBe(true);

    expect(launcher.calls).toEqual([["open", ["file:///tmp/My%20composition%20%231.html"]]]);
  });

  test("uses shell-free platform commands", async () => {
    const linuxLauncher = recordingLauncher();
    const windowsLauncher = recordingLauncher();

    await openCompletedCompositionInBrowser(
      "/tmp/composition.html",
      context({ platform: "linux" }),
      linuxLauncher,
    );
    await openCompletedCompositionInBrowser(
      "/tmp/composition.html",
      context({ platform: "win32" }),
      windowsLauncher,
    );

    expect(linuxLauncher.calls).toEqual([["xdg-open", ["file:///tmp/composition.html"]]]);
    expect(windowsLauncher.calls).toEqual([
      ["rundll32.exe", ["url.dll,FileProtocolHandler", "file:///tmp/composition.html"]],
    ]);
  });

  test("never launches for a skipped context, non-HTML file, or relative path", async () => {
    const launcher = recordingLauncher();

    expect(
      await openCompletedCompositionInBrowser(
        "/tmp/composition.html",
        context({ env: { JAZZ_SURFACE: "discord" } }),
        launcher,
      ),
    ).toBe(false);
    expect(
      await openCompletedCompositionInBrowser("/tmp/composition.txt", context(), launcher),
    ).toBe(false);
    expect(await openCompletedCompositionInBrowser("composition.html", context(), launcher)).toBe(
      false,
    );
    expect(launcher.calls).toEqual([]);
  });

  test("swallows opener failures so previewing cannot fail composition creation", async () => {
    const launcher: CompositionBrowserLauncher = {
      launch: async () => Promise.reject(new Error("No desktop session")),
    };

    await expect(
      openCompletedCompositionInBrowser("/tmp/composition.html", context(), launcher),
    ).resolves.toBe(false);
  });
});
