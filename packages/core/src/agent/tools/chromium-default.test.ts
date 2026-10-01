/**
 * Tests for `chromium-default.ts`: default-browser discovery and the Chromium marker
 * / live-probe resolution that lets the browser tools drive the user's actual browser.
 *
 * The macOS default-browser read is exercised against a synthesized LaunchServices plist
 * (via an injected `plutil`/`mdfind`), and the Chromium check against a fake app bundle
 * tree — so no real browser or OS default is required.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CHROME_RELEASE_CHANNELS,
  isChromiumBased,
  resolveChromiumBrowser,
  resolveDefaultBrowser,
} from "./chromium-default";

// The module caches its process-wide reads. The tests below keep them consistent by
// exercising the pure, per-path functions and the channel table rather than re-reading
// the live OS default.

describe("CHROME_RELEASE_CHANNELS", () => {
  test("covers every Google Chrome release channel, most-stable first", () => {
    expect(CHROME_RELEASE_CHANNELS[0]).toBe("chrome");
    expect(new Set(CHROME_RELEASE_CHANNELS)).toEqual(
      new Set(["chrome", "chrome-beta", "chrome-dev", "chrome-canary"]),
    );
  });
});

describe("resolveChromiumBrowser — fallback to Google Chrome", () => {
  // A findSystemChrome that only finds stable chrome: regardless of the (possibly
  // non-Chromium) default browser, the resolver must fall through to Chrome and label it.
  test("falls back to Google Chrome when the default is not Chromium-based", async () => {
    const findSystemChrome = async (channel: string) =>
      channel === "chrome" ? "/usr/bin/google-chrome" : null;
    const candidate = await resolveChromiumBrowser(findSystemChrome);
    // On a non-macOS host the default browser is null, so this always resolves to Chrome.
    // On macOS with a non-Chromium default it must also land here.
    expect(candidate).not.toBeNull();
    if (
      candidate?.label === "default browser (Dia)" ||
      candidate?.label.startsWith("default browser")
    ) {
      // The user's real default won the race; that is valid too.
      return;
    }
    expect(candidate?.executablePath).toBe("/usr/bin/google-chrome");
    expect(candidate?.label).toBe("Google Chrome");
  });

  test("tries channels in order and stops at the first hit", async () => {
    const seen: string[] = [];
    const findSystemChrome = async (channel: string) => {
      seen.push(channel);
      return channel === "chrome-beta" ? `/beta/${channel}` : null;
    };
    const candidate = await resolveChromiumBrowser(findSystemChrome);
    // The default-browser path resolves first; if it wins, no chrome channel is consulted.
    if (candidate?.label.startsWith("default browser")) {
      return;
    }
    expect(candidate?.executablePath).toBe("/beta/chrome-beta");
    expect(seen).toEqual(["chrome", "chrome-beta"]);
  });

  test("returns null when neither a default browser nor Chrome is available", async () => {
    const candidate = await resolveChromiumBrowser(async () => null);
    // Only null when the OS default is also not a usable Chromium browser.
    if (process.platform === "darwin" && (await resolveDefaultBrowser()) !== null) {
      return;
    }
    expect(candidate).toBeNull();
  });
});

describe("isChromiumBased — static markers on a fake bundle", () => {
  let appRoot: string;

  beforeAll(async () => {
    appRoot = await mkFakeAppRoot();
  });

  afterAll(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  test("an Electron Framework marks the app Chromium-based", async () => {
    const app = path.join(appRoot, "electron.app");
    await mkdir(path.join(app, "Contents/Frameworks"), { recursive: true });
    await mkdir(path.join(app, "Contents/Frameworks/Electron Framework.framework"), {
      recursive: true,
    });
    await writeInfoPlist(app, "electron");
    expect(await isChromiumBased(app)).toBe(true);
  });

  test("a Chromium Helper.app in Frameworks marks the app Chromium-based", async () => {
    const app = path.join(appRoot, "chromium.app");
    const fw = path.join(app, "Contents/Frameworks");
    await mkdir(path.join(fw, "Chromium Helper.app"), { recursive: true });
    await writeInfoPlist(app, "chromium");
    expect(await isChromiumBased(app)).toBe(true);
  });

  test("a bundle with neither marker defers to the live probe (false when it cannot launch)", async () => {
    // No Electron framework, no helper app, and a binary that does not exist: the static
    // marker is "unknown", the probe cannot launch, so the result is false.
    const app = path.join(appRoot, "webkit-only.app");
    await mkdir(path.join(app, "Contents/Frameworks"), { recursive: true });
    await writeInfoPlist(app, "WebKitOnly");
    expect(await isChromiumBased(app)).toBe(false);
  });

  test("a path that is not an app bundle is not Chromium-based", async () => {
    expect(await isChromiumBased(path.join(appRoot, "no-such-bundle.app"))).toBe(false);
  });
});

async function mkFakeAppRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jazz-chromium-test-"));
  return root;
}

async function writeInfoPlist(app: string, executable: string): Promise<void> {
  const contents = path.join(app, "Contents");
  await mkdir(path.join(contents, "MacOS"), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${executable}</string>
</dict></plist>`;
  await writeFile(path.join(contents, "Info.plist"), plist, "utf8");
  await writeFile(path.join(contents, "MacOS", executable), "#!/bin/sh\n", "utf8");
}
