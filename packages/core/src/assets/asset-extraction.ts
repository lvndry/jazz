/**
 * Unpacks the assets embedded in a standalone binary onto the real filesystem.
 *
 * Embedded files are readable in place, but only one at a time and only by the
 * exact path the bundler assigned them — there is no directory to list and no
 * package root to resolve against. Every built-in persona and skill
 * loader expects a directory it can walk, and the bundled `terminal-notifier`
 * has to be a real executable on disk before it can be spawned. So the binary
 * unpacks its assets once per version and hands the loaders that directory.
 */
import fs from "node:fs";
import path from "node:path";
// Imported through the path alias, not relatively: the standalone build swaps
// this module out by matching the alias in scripts/build.ts.
import { EMBEDDED_ASSET_FILES, type EmbeddedAssetFile } from "@/core/assets/embedded-assets";

/**
 * Reports whether the running build carries embedded assets.
 *
 * True only in a standalone binary; the npm package and development mode read
 * the checked-in directories instead.
 */
export function hasEmbeddedAssets(): boolean {
  return EMBEDDED_ASSET_FILES.length > 0;
}

/**
 * Unpacks this build's embedded assets into `destinationRoot`, once.
 *
 * @param destinationRoot - Directory to unpack into.
 * @returns The unpacked directory, or `null` when there is nothing to unpack or
 *   extraction failed.
 */
export function extractEmbeddedAssets(destinationRoot: string): string | null {
  if (!hasEmbeddedAssets()) {
    return null;
  }

  return extractAssetsInto(EMBEDDED_ASSET_FILES, destinationRoot);
}

/**
 * Unpacks `assets` into `destinationRoot`, once.
 *
 * Extraction goes to a sibling temporary directory and is moved into place with
 * a single rename, so `destinationRoot` never exists in a half-written state
 * and concurrent Jazz processes cannot read a partial copy. The directory is
 * versioned by the caller, which is what makes "already exists" a safe skip.
 *
 * @param assets - Files to unpack.
 * @param destinationRoot - Directory to unpack into.
 * @returns The unpacked directory, or `null` when extraction failed.
 */
export function extractAssetsInto(
  assets: readonly EmbeddedAssetFile[],
  destinationRoot: string,
): string | null {
  if (fs.existsSync(destinationRoot)) {
    return destinationRoot;
  }

  const stagingRoot = `${destinationRoot}.partial-${process.pid}`;

  try {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.mkdirSync(stagingRoot, { recursive: true });

    for (const asset of assets) {
      const stagedPath = path.join(stagingRoot, asset.relativePath);
      fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
      // Read-then-write rather than copyFileSync: the embedded source lives in
      // Bun's virtual filesystem, which serves reads but fails copyfile(2) with
      // ENOENT.
      fs.writeFileSync(stagedPath, fs.readFileSync(asset.sourcePath), {
        mode: asset.executable ? 0o755 : 0o644,
      });
    }

    fs.mkdirSync(path.dirname(destinationRoot), { recursive: true });
    fs.renameSync(stagingRoot, destinationRoot);
    return destinationRoot;
  } catch {
    // A concurrent Jazz process extracting the same version wins the rename,
    // which leaves the assets in place and this process with nothing to do.
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    return fs.existsSync(destinationRoot) ? destinationRoot : null;
  }
}

const CLAIMS_DIRECTORY_NAME = ".in-use";
const TRANSIENT_DIRECTORY_PATTERN = /\.(?:partial|pruning)-(\d+)$/;
const VERSION_DIRECTORY_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/**
 * How long a version directory without a live claim is kept after its claims last changed,
 * or after it was first found with no claims at all. Binaries older than claims never write
 * one, so this is the only protection a session started by them gets; a week outlasts a
 * normal session, and the cost is one leftover copy of about 1 MB.
 */
export const UNCLAIMED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const registeredClaimPaths = new Set<string>();

function getClaimsDirectory(runtimeRoot: string, version: string): string {
  return path.join(runtimeRoot, CLAIMS_DIRECTORY_NAME, version);
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isClaimedByLiveProcess(claimsDirectory: string): boolean {
  let markers: string[];
  try {
    markers = fs.readdirSync(claimsDirectory);
  } catch {
    return false;
  }
  return markers.some((marker) => {
    const processId = Number(marker);
    return Number.isInteger(processId) && processId > 0 && isProcessAlive(processId);
  });
}

/**
 * Records that this process reads `version`'s unpacked assets until it exits.
 *
 * A Jazz session keeps loading personas and skills long after startup, so a
 * newer version starting after `jazz update` must not prune them out from
 * under it. Claims live beside the asset directories rather than inside them,
 * so writing one never recreates a pruned directory as an empty shell. The
 * marker is removed on exit; one left by a crashed process stops counting once
 * its pid is no longer alive.
 *
 * @param runtimeRoot - Directory holding the per-version asset directories.
 * @param version - Name of the asset directory this process uses.
 */
export function claimAssetDirectory(runtimeRoot: string, version: string): void {
  const markerPath = path.join(getClaimsDirectory(runtimeRoot, version), String(process.pid));
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "");
  } catch {
    // An unclaimed directory is still kept for UNCLAIMED_RETENTION_MS, and a
    // running binary unpacks its assets again if they are pruned anyway.
    return;
  }
  if (!registeredClaimPaths.has(markerPath)) {
    registeredClaimPaths.add(markerPath);
    process.once("exit", () => {
      fs.rmSync(markerPath, { force: true });
    });
  }
}

function shouldKeepVersionDirectory(claimsDirectory: string, now: number): boolean {
  let claimsChangedAt: number;
  try {
    claimsChangedAt = fs.statSync(claimsDirectory).mtimeMs;
  } catch {
    try {
      fs.mkdirSync(claimsDirectory, { recursive: true });
    } catch {
      // Retention starts on a later run instead.
    }
    return true;
  }
  if (isClaimedByLiveProcess(claimsDirectory)) {
    return true;
  }
  return now - claimsChangedAt < UNCLAIMED_RETENTION_MS;
}

/**
 * Deletes unpacked asset directories other versions no longer need.
 *
 * A self-updating binary replaces itself in place, so without this every
 * upgrade would leave its predecessor's assets on disk forever. Only
 * directories named for a version are considered, since other state such as
 * daemon status files shares `runtimeRoot`. A version
 * directory is deleted only once no live process claims it and its claims
 * have been idle for UNCLAIMED_RETENTION_MS. It is renamed aside before
 * deletion so no reader ever sees a partly deleted copy. Staging and
 * mid-deletion directories are kept while the process that owns them is alive.
 *
 * @param runtimeRoot - Directory holding the per-version asset directories.
 * @param currentVersionDirectory - Name of the directory to keep.
 * @param now - Current time in milliseconds, for retention checks.
 */
export function pruneStaleAssetDirectories(
  runtimeRoot: string,
  currentVersionDirectory: string,
  now: number = Date.now(),
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(runtimeRoot);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry === currentVersionDirectory || entry === CLAIMS_DIRECTORY_NAME) {
      continue;
    }
    // Pruning is housekeeping; a failure on one entry must not stop Jazz from starting.
    try {
      const entryPath = path.join(runtimeRoot, entry);
      if (!fs.lstatSync(entryPath).isDirectory()) {
        continue;
      }
      const transientOwnerId = TRANSIENT_DIRECTORY_PATTERN.exec(entry)?.[1];
      if (transientOwnerId !== undefined) {
        if (!isProcessAlive(Number(transientOwnerId))) {
          fs.rmSync(entryPath, { recursive: true, force: true });
        }
        continue;
      }
      if (!VERSION_DIRECTORY_PATTERN.test(entry)) {
        continue;
      }

      const claimsDirectory = getClaimsDirectory(runtimeRoot, entry);
      if (shouldKeepVersionDirectory(claimsDirectory, now)) {
        continue;
      }
      const pruningPath = path.join(runtimeRoot, `${entry}.pruning-${process.pid}`);
      fs.renameSync(entryPath, pruningPath);
      fs.rmSync(pruningPath, { recursive: true, force: true });
      fs.rmSync(claimsDirectory, { recursive: true, force: true });
    } catch {
      continue;
    }
  }

  pruneOrphanClaims(runtimeRoot, new Set(entries));
}

function pruneOrphanClaims(runtimeRoot: string, presentEntries: ReadonlySet<string>): void {
  const claimsRoot = path.join(runtimeRoot, CLAIMS_DIRECTORY_NAME);
  let claimedVersions: string[];
  try {
    claimedVersions = fs.readdirSync(claimsRoot);
  } catch {
    return;
  }
  for (const version of claimedVersions) {
    const claimsDirectory = path.join(claimsRoot, version);
    if (presentEntries.has(version) || isClaimedByLiveProcess(claimsDirectory)) {
      continue;
    }
    fs.rmSync(claimsDirectory, { recursive: true, force: true });
  }
}
