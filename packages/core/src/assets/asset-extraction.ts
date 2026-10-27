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

const IN_USE_DIRECTORY_NAME = ".in-use";
const STAGING_SUFFIX_PATTERN = /\.partial-(\d+)$/;

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isInUseByLiveProcess(assetDirectory: string): boolean {
  let markers: string[];
  try {
    markers = fs.readdirSync(path.join(assetDirectory, IN_USE_DIRECTORY_NAME));
  } catch {
    return false;
  }
  return markers.some((marker) => {
    const processId = Number(marker);
    return Number.isInteger(processId) && processId > 0 && isProcessAlive(processId);
  });
}

/**
 * Records that this process reads from `assetDirectory` until it exits.
 *
 * A Jazz session keeps loading personas and skills from its version's directory
 * long after startup, so a newer version starting after `jazz update` must not
 * prune it out from under the session. The marker is removed on exit; a marker
 * left by a crashed process is ignored once its pid is no longer alive.
 *
 * @param assetDirectory - The unpacked asset directory this process uses.
 */
export function claimAssetDirectory(assetDirectory: string): void {
  const markerPath = path.join(assetDirectory, IN_USE_DIRECTORY_NAME, String(process.pid));
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "");
    process.once("exit", () => {
      fs.rmSync(markerPath, { force: true });
    });
  } catch {
    // Without the marker the directory may be pruned early; Jazz still starts.
  }
}

/**
 * Deletes unpacked asset directories left behind by other versions.
 *
 * A self-updating binary replaces itself in place, so without this every
 * upgrade would leave its predecessor's assets on disk forever. Directories a
 * live process has claimed, and staging directories a live process is still
 * extracting into, are kept.
 *
 * @param runtimeRoot - Directory holding the per-version asset directories.
 * @param currentVersionDirectory - Name of the directory to keep.
 */
export function pruneStaleAssetDirectories(
  runtimeRoot: string,
  currentVersionDirectory: string,
): void {
  try {
    for (const entry of fs.readdirSync(runtimeRoot)) {
      if (entry === currentVersionDirectory) {
        continue;
      }
      const entryPath = path.join(runtimeRoot, entry);
      const stagingProcessId = STAGING_SUFFIX_PATTERN.exec(entry)?.[1];
      if (stagingProcessId !== undefined && isProcessAlive(Number(stagingProcessId))) {
        continue;
      }
      if (isInUseByLiveProcess(entryPath)) {
        continue;
      }
      fs.rmSync(entryPath, { recursive: true, force: true });
    }
  } catch {
    // Pruning is housekeeping; a failure here must not stop Jazz from starting.
  }
}
