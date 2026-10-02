/**
 * Real-profile snapshot for the browser tools' launch path.
 *
 * A run that launches a browser on the user's own machine can drive a snapshot of their
 * actual profile: cookies and logins carry over, so the agent can read signed-in pages
 * without the user doing anything. The clone is private — the run may write to it, but the
 * user's live profile is never touched while their browser is open.
 *
 * Finding the profile is a platform concern, so it goes through a small registry of
 * platform strategies (`PROFILE_LAYOUT_STRATEGIES`): each names the candidate on-disk
 * locations for a browser executable and whether the browser nests the profile in a
 * `User Data/` wrapper folder. Adding a platform means adding a strategy and registering
 * it — the snapshot, cache-pruning, and singleton-stripping paths are shared.
 *
 * Two layout quirks are load-bearing. First, Chromium forks such as Arc/Dia wrap their
 * profile in a `User Data/` subfolder under the user-data directory while Google Chrome
 * and Brave use the directory itself; the snapshot mirrors the app's real layout. Second,
 * the launch path strips the `Singleton{Cookie,Lock,Socket}` triple before spawning: a
 * cloned `SingletonLock` points at the user's still-running browser, and a browser handed
 * such a lock forwards to the existing instance and exits without opening its DevTools
 * port.
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Profile-relative directories that weigh a clone down and carry no logins. */
const PRUNED_CACHE_DIRS: readonly string[] = [
  "Code Cache",
  "GPUPersistentCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Dictionaries",
  "CachedData",
  "Service Worker/CacheStorage",
];

/** The singleton triple a running Chromium instance maintains in its profile directory. */
const SINGLETON_FILES: readonly string[] = ["SingletonCookie", "SingletonLock", "SingletonSocket"];

/** The on-disk layout of a browser's profile, as found on disk. */
export interface RealProfileLayout {
  /** The profile's on-disk directory (holds `Local State` and the profile folders). */
  readonly profileDirectory: string;
  /**
   * Whether the browser nests its profile in a `User Data/` folder under the user-data
   * directory (the Arc/Dia fork layout) versus the stock flat layout.
   */
  readonly wrapped: boolean;
}

/** A clone of a real profile, private to one run. */
export interface RealProfileSnapshot {
  /** The temporary directory to pass to the browser as its user-data directory. */
  readonly profileDirectory: string;
  /** Remove the snapshot. Idempotent. */
  release(): Promise<void>;
}

/**
 * A platform strategy for locating a browser's on-disk profile.
 */
interface ProfileLayoutStrategy {
  readonly platform: string;
  /**
   * Candidate profile directories for a browser executable, in priority order. Each
   * candidate is a full path (the wrapper folder, if any, is part of it); the first one
   * that passes {@link isProfileDir} wins.
   */
  candidateProfileDirs(executablePath: string): string[];
}

function darwinProfileDirs(executablePath: string): string[] {
  const marker = "/Contents/MacOS/";
  const index = executablePath.indexOf(marker);
  if (index === -1) {
    return [];
  }
  const appName = path.basename(executablePath.slice(0, index), ".app");
  // Browsers whose Application Support directory does not match the bundle name.
  const KNOWN_SUPPORT_DIRS: Record<string, string> = {
    "Google Chrome": "Google/Chrome",
    "Brave Browser": "BraveSoftware/Brave-Browser",
  };
  const support = path.join(homedir(), "Library/Application Support");
  const dir = KNOWN_SUPPORT_DIRS[appName] ?? appName;
  return [path.join(support, dir, "User Data"), path.join(support, dir)];
}

/**
 * Linux: Chromium-based browsers keep their profile under an XDG-style state directory,
 * almost universally `~/.config/<BrowserName>` (Brave: `~/.config/brave-browser`, Chrome:
 * `~/.config/google-chrome`). The flat layout is the stock one; a `User Data/` wrapper
 * does not occur on Linux today.
 */
function linuxProfileDirs(executablePath: string): string[] {
  const base = path.basename(executablePath);
  const config = path.join(homedir(), ".config");
  const candidates: string[] = [];
  const known: Record<string, readonly string[]> = {
    brave: ["brave-browser", "brave"],
    "brave-browser": ["brave-browser"],
    "google-chrome": ["google-chrome"],
    chrome: ["google-chrome", "chromium", "chromium-browser"],
    chromium: ["chromium", "chromium-browser"],
    "chromium-browser": ["chromium-browser", "chromium"],
    "microsoft-edge": ["microsoft-edge"],
    vivaldi: ["vivaldi"],
    opera: ["opera"],
  };
  const names = known[base.toLowerCase()] ?? [base.toLowerCase()];
  for (const name of names) {
    candidates.push(path.join(config, name));
  }
  return candidates;
}

/**
 * The platform registry. Add a platform by implementing {@link ProfileLayoutStrategy} and
 * registering it here; `findRealProfileLayout` picks the entry matching `process.platform`
 * and returns `null` (blank profile) where no strategy exists.
 */
const PROFILE_LAYOUT_STRATEGIES: readonly ProfileLayoutStrategy[] = [
  { platform: "darwin", candidateProfileDirs: darwinProfileDirs },
  { platform: "linux", candidateProfileDirs: linuxProfileDirs },
] as const;

/**
 * Locate the on-disk profile for a browser executable on this platform, or `null` when the
 * platform has no strategy, the browser is not a recognized Chromium layout, or nothing on
 * disk passes the profile check.
 */
export async function findRealProfileLayout(
  executablePath: string,
): Promise<RealProfileLayout | null> {
  const strategy = PROFILE_LAYOUT_STRATEGIES.find((entry) => entry.platform === process.platform);
  if (strategy === undefined) {
    return null;
  }
  for (const candidate of strategy.candidateProfileDirs(executablePath)) {
    if (await isProfileDir(candidate)) {
      return { profileDirectory: candidate, wrapped: path.basename(candidate) === "User Data" };
    }
  }
  return null;
}

/**
 * A Chromium profile directory has a `Local State` file and a profile folder (near-
 * universally `Default`) with a `Cookies` database.
 */
async function isProfileDir(candidate: string): Promise<boolean> {
  if (!(await exists(path.join(candidate, "Local State")))) {
    return false;
  }
  for (const profile of ["Default", ...(await profileNames(candidate))]) {
    if (await exists(path.join(candidate, profile, "Cookies"))) {
      return true;
    }
  }
  return false;
}

async function profileNames(profileRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(profileRoot);
    return entries.filter((entry) => /^Profile \d+$/.test(entry));
  } catch {
    return [];
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/**
 * Clone `sourceProfile` into `temporaryRoot` and return a snapshot a browser can be launched
 * on. The clone is a CoW copy (`cp -c -R` on APFS), so a multi-gigabyte profile is a matter
 * of seconds; heavy caches are dropped from the clone afterwards. Resolves `null` when the
 * source is missing or the clone fails — the caller then falls back to a blank profile.
 */
export async function snapshotRealProfile(
  sourceProfile: string,
  wrapped: boolean,
  temporaryRoot: string,
): Promise<RealProfileSnapshot | null> {
  // `profileDirectory` is the on-disk profile location the browser must be pointed at:
  //   wrapped (Arc/Dia fork layout) → <temporaryRoot>/User Data, mirroring the real app
  //   flat (Chrome, Brave, Linux)   → <temporaryRoot> itself, where Local State + Default live
  // In both cases the clone replaces the (removed) target path with a copy of the source.
  const profileDirectory = wrapped ? path.join(temporaryRoot, "User Data") : temporaryRoot;
  await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  if (wrapped) {
    await mkdir(temporaryRoot, { recursive: true });
  }
  try {
    await copyTree(sourceProfile, profileDirectory);
    await pruneCaches(profileDirectory);
    return {
      profileDirectory: temporaryRoot,
      release: async () => {
        await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
}

/**
 * Copy a profile tree. On APFS (`darwin`) a `cp -c` clones the blocks, so a multi-gigabyte
 * profile is a matter of seconds; `cp -c` is a BSD flag, so every other platform gets a
 * plain `cp -R` full copy. The failure of the preferred form never fails the snapshot: it
 * falls back to the full copy before giving up.
 */
async function copyTree(source: string, destination: string): Promise<void> {
  const forms: string[][] = process.platform === "darwin" ? [["-c", "-R"], ["-R"]] : [["-R"]];
  let lastError: unknown;
  for (const args of forms) {
    try {
      await cpShell("cp", [...args, source, destination]);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("profile copy failed");
}

function cpShell(binary: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${binary} exited ${String(code)}`)),
    );
  });
}

/**
 * Remove the singleton triple from the profile root (and its `User Data/` wrapper) so a
 * launched instance does not treat the user's running browser as the profile owner.
 */
export async function stripSingletonLocks(profileDirectory: string): Promise<void> {
  for (const root of [profileDirectory, path.join(profileDirectory, "User Data")]) {
    for (const file of SINGLETON_FILES) {
      await rm(path.join(root, file), { force: true }).catch(() => undefined);
    }
  }
}

/** Drop the known cache directories from every profile in the clone. */
async function pruneCaches(profileRoot: string): Promise<void> {
  for (const profile of ["Default", ...(await profileNames(profileRoot))]) {
    for (const cache of PRUNED_CACHE_DIRS) {
      await rm(path.join(profileRoot, profile, cache), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}
