/**
 * Resolve a Chromium-based browser the user actually uses, for the browser tools' launch path.
 *
 * Resolution order, first hit wins:
 *   1. the operating system default web browser, when it is Chromium-based (macOS only today)
 *   2. an installed Google Chrome (any release channel)
 *
 * The default-browser read is cached for the process — the OS default and a bundle's
 * packaging do not change under a running agent. The Chromium check itself is static
 * markers first (cheap) and a live CDP probe only when the markers are inconclusive;
 * the probe is the only authoritative check, so it also arbitrates a marker mismatch.
 */

import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

/** Chrome release channels, the same set `puppeteer-core`'s `ChromeReleaseChannel` allows. */
type ChromeReleaseChannel = "chrome" | "chrome-beta" | "chrome-dev" | "chrome-canary";

/** Chrome release channels in priority order, shared with the composition launch path. */
export const CHROME_RELEASE_CHANNELS: readonly ChromeReleaseChannel[] = [
  "chrome",
  "chrome-beta",
  "chrome-dev",
  "chrome-canary",
];

/** Probe ports try in order; the first that answers is the one the probe owns. */
const PROBE_PORTS: readonly number[] = [9311, 9312, 9313];
/** How long a probe launch may take before it is declared "not Chromium-based". */
const PROBE_TIMEOUT_MS = 6_000;
/** A probe profile under tmpdir, removed when the run ends. */
const PROBE_PROFILE_MARKER = "jazz.chromium-probe";

/** A resolved, launchable browser executable. */
export interface ChromiumCandidate {
  readonly executablePath: string;
  /** What the candidate is, for log lines and the "which browser" explanation. */
  readonly label: string;
}

/** The OS default web browser's bundle, resolved on disk. */
interface DefaultBundle {
  readonly appPath: string;
  readonly bundleId: string;
}

let defaultBundleMemo: Promise<DefaultBundle | null> | null = null;
const chromiumMemo = new Map<string, Promise<boolean>>();

/**
 * Find the OS default web browser (macOS). Resolves `null` when there is no default, the
 * bundle is missing, or the platform is not supported. Never throws — this is discovery,
 * and the caller has a fallback.
 */
export function resolveDefaultBrowser(): Promise<DefaultBundle | null> {
  if (process.platform !== "darwin") {
    return Promise.resolve(null);
  }
  if (defaultBundleMemo === null) {
    defaultBundleMemo = readDefaultBundle().catch(() => null);
  }
  return defaultBundleMemo;
}

async function readDefaultBundle(): Promise<DefaultBundle | null> {
  const plist = path.join(
    homedir(),
    "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
  );
  let raw: string;
  try {
    const result = await pexecFile("plutil", ["-convert", "xml1", "-o", "-", plist], {
      maxBuffer: 4 * 1024 * 1024,
    });
    raw = result.stdout;
  } catch {
    return null;
  }
  const bundleId = handlerBundleId(raw, "https") ?? handlerBundleId(raw, "http");
  if (bundleId === null) {
    return null;
  }
  const appPath = await bundleIdToAppPath(bundleId);
  if (appPath === null) {
    return null;
  }
  return { appPath, bundleId };
}

/** The role-all handler for one URL scheme, or null when the plist names no such handler. */
function handlerBundleId(plistXml: string, scheme: "http" | "https"): string | null {
  // The handlers live in a top-level LSHandlers array. Split on entry boundaries so a
  // nested dict (LSHandlerPreferredVersions) does not stop the match early. Within an
  // entry the top-level LSHandlerRoleAll is the LAST one — the PreferredVersions copy
  // comes first, so take the last match.
  const arrayMatch = plistXml.match(/<key>LSHandlers<\/key>\s*<array>([\s\S]*?)<\/array>/);
  const parts = (arrayMatch?.[1] ?? "").split(/<\/dict>\s*(?=<dict>)/);
  for (const part of parts) {
    const schemeMatch = part.match(/<key>LSHandlerURLScheme<\/key>\s*<string>([^<]+)<\/string>/);
    if (schemeMatch?.[1] !== scheme) continue;
    const roles = [
      ...part.matchAll(/<key>LSHandlerRoleAll<\/key>\s*<string>([^<]+)<\/string>/g),
    ].map((m) => m[1]);
    const role = roles[roles.length - 1];
    if (role !== undefined && role.length > 0) {
      return role;
    }
  }
  return null;
}

async function bundleIdToAppPath(bundleId: string): Promise<string | null> {
  // Spotlight is the authoritative bundle-id-to-path lookup and returns the exact on-disk
  // case. A name guessed from the bundle id (company.thebrowser.dia -> dia.app) matches on
  // case-insensitive filesystems but is not the real path, so it is only a fallback.
  try {
    const found = await pexecFile("mdfind", [
      `kMDItemCFBundleIdentifier == '${bundleId.replace(/'/g, "'\\''")}'`,
    ]);
    for (const line of found.stdout.split("\n")) {
      const linePath = line.trim();
      if (linePath.endsWith(".app") && (await isAppBundle(linePath))) {
        return linePath;
      }
    }
  } catch {
    // Spotlight unavailable: fall through to the guessed paths.
  }
  const suffix = bundleId.split(".").pop() ?? bundleId;
  const guesses: readonly string[] = [
    `/Applications/${suffix}.app`,
    path.join(homedir(), "Applications", `${suffix}.app`),
  ];
  for (const candidate of guesses) {
    if (await isAppBundle(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function isAppBundle(candidate: string): Promise<boolean> {
  const executable = await readExecutableName(candidate);
  if (executable === null) {
    return false;
  }
  return (
    (await stat(path.join(candidate, "Contents/MacOS", executable)).catch(() => null)) !== null
  );
}

async function readExecutableName(appPath: string): Promise<string | null> {
  try {
    const info = await readFile(path.join(appPath, "Contents/Info.plist"));
    const xml = new TextDecoder().decode(info);
    const match = xml.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Is `appPath` Chromium-based, i.e. will it speak CDP when launched with
 * --remote-debugging-port? Static markers first (cheap, cached), a live probe only when
 * the markers are inconclusive.
 */
export async function isChromiumBased(appPath: string): Promise<boolean> {
  const memo = chromiumMemo.get(appPath);
  if (memo !== undefined) {
    return memo;
  }
  const result = (async () => {
    const marker = await staticChromiumMarker(appPath);
    if (marker === "yes" || marker === "no") {
      return marker === "yes";
    }
    return probeSpeaksDevToolsProtocol(appPath);
  })().catch(() => false);
  chromiumMemo.set(appPath, result);
  return result;
}

/** `yes`/`no` from static markers, `unknown` when only a live probe can decide. */
async function staticChromiumMarker(appPath: string): Promise<"yes" | "no" | "unknown"> {
  const frameworksDir = path.join(appPath, "Contents/Frameworks");
  let frameworkNames: string[];
  try {
    frameworkNames = await readdir(frameworksDir);
  } catch {
    return "unknown";
  }
  if (frameworkNames.some((name) => name === "Electron Framework.framework")) {
    return "yes";
  }
  // A `<Name> Helper.app` is the canonical Chromium multi-process packaging: the helper is
  // the renderer. A WebKit framework is not a marker against Chromium — apps can link both.
  if (
    frameworkNames.some((name) => name.endsWith("Helper.app")) ||
    (await dirHasHelper(path.join(appPath, "Contents/PlugIns")))
  ) {
    return "yes";
  }
  return "unknown";
}

async function dirHasHelper(dir: string): Promise<boolean> {
  try {
    const names = await readdir(dir);
    return names.some((name) => name.endsWith("Helper.app"));
  } catch {
    return false;
  }
}

/**
 * The only authoritative check: launch the candidate on a scratch port with a throwaway
 * profile and read its /json/version. Returns false on any failure — a browser that cannot
 * be probed here cannot be trusted to be drivable, so the caller falls through.
 */
async function probeSpeaksDevToolsProtocol(appPath: string): Promise<boolean> {
  const executableName = await readExecutableName(appPath);
  if (executableName === null) {
    return false;
  }
  const executable = path.join(appPath, "Contents/MacOS", executableName);
  if (!isExecutable(executable)) {
    return false;
  }
  const profile = path.join(tmpdir(), `${PROBE_PROFILE_MARKER}-${String(process.pid)}`);
  for (const port of PROBE_PORTS) {
    const child = spawn(
      executable,
      [
        `--remote-debugging-port=${String(port)}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
      { stdio: "ignore", detached: true },
    );
    child.on("error", () => undefined);
    const version = await waitForDevTools(
      `http://127.0.0.1:${String(port)}/json/version`,
      PROBE_TIMEOUT_MS,
    );
    child.kill("SIGKILL");
    if (version !== null) {
      return true;
    }
  }
  return false;
}

async function waitForDevTools(url: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const body = (await response.json()) as { Browser?: string };
        return typeof body.Browser === "string" && body.Browser.startsWith("Chrome/")
          ? body.Browser
          : null;
      }
    } catch {
      // Not answering yet: the loop retries until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/**
 * Resolve the launch browser: the default browser when Chromium-based, else Google
 * Chrome via `findSystemChrome`, else null (the caller explains what to install).
 *
 * `findSystemChrome` is the existing channel-based Chrome lookup, passed in so the caller's
 * executable-path override (PUPPETEER_EXECUTABLE_PATH) stays in control and so this function
 * is testable without a real OS.
 */
export async function resolveChromiumBrowser(
  findSystemChrome: (channel: ChromeReleaseChannel) => Promise<string | null>,
): Promise<ChromiumCandidate | null> {
  const defaultBundle = await resolveDefaultBrowser();
  if (defaultBundle !== null && (await isChromiumBased(defaultBundle.appPath))) {
    const executable = await bundleExecutable(defaultBundle.appPath);
    if (executable !== null) {
      return {
        executablePath: executable,
        label: `default browser (${path.basename(defaultBundle.appPath, ".app")})`,
      };
    }
  }
  for (const channel of CHROME_RELEASE_CHANNELS) {
    const chrome = await findSystemChrome(channel);
    if (chrome !== null) {
      return { executablePath: chrome, label: "Google Chrome" };
    }
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    const mode = statSync(file).mode;
    return (mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function bundleExecutable(appPath: string): Promise<string | null> {
  const name = await readExecutableName(appPath);
  if (name === null) {
    return null;
  }
  const executable = path.join(appPath, "Contents/MacOS", name);
  return (await stat(executable).catch(() => null)) !== null ? executable : null;
}

/**
 * The message a run gets when no Chromium-based browser could be resolved: what Jazz looked
 * for, in the order it looked, and what the user can do.
 */
export function describeMissingBrowser(): string {
  return (
    "No Chromium-based browser is available for the browser tools. Jazz looks for the " +
    "system default web browser (when Chromium-based), then for Google Chrome, and found " +
    "neither. Install Google Chrome (https://google.com/chrome) or point " +
    "PUPPETEER_EXECUTABLE_PATH at a Chromium-based browser binary."
  );
}
