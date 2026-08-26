import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { type TerminalService } from "@jazz/core/interfaces/terminal";
import { UpdateInstallError } from "@jazz/core/types/errors";
import { Effect } from "effect";

/**
 * In-place updates for standalone binary installations.
 *
 * A binary install has no package manager behind it, so `jazz update` cannot
 * shell out to one. Instead it does what the install script does — pick the
 * asset matching this machine, verify it against the release checksums, and put
 * it on disk — with the wrinkle that the file being replaced is the running
 * program.
 */

const RELEASE_DOWNLOAD_BASE = "https://github.com/lvndry/jazz/releases/download";
const CHECKSUM_FILE = "SHA256SUMS";

/**
 * Detects whether this Linux system uses musl rather than glibc.
 *
 * Bun's glibc binaries do not run on musl distributions such as Alpine, so the
 * two need separate release assets and the loader on disk is what tells them
 * apart.
 */
function isMuslLinux(): boolean {
  return (
    fs.existsSync("/lib/ld-musl-x86_64.so.1") ||
    fs.existsSync("/lib/ld-musl-aarch64.so.1") ||
    fs.existsSync("/etc/alpine-release")
  );
}

/**
 * Returns the release asset name matching the running platform.
 *
 * @returns The asset name, or `null` on a platform Jazz publishes no binary for.
 */
export function resolveReleaseAssetName(): string | null {
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!architecture) {
    return null;
  }

  if (process.platform === "darwin") {
    return `jazz-darwin-${architecture}`;
  }

  if (process.platform === "linux") {
    return `jazz-linux-${architecture}${isMuslLinux() ? "-musl" : ""}`;
  }

  return null;
}

function fetchRelease(
  url: string,
  description: string,
): Effect.Effect<ArrayBuffer, UpdateInstallError> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(url, { redirect: "follow" }),
      catch: (cause: unknown) =>
        new UpdateInstallError({ message: `Failed to download ${description}`, cause }),
    });

    if (!response.ok) {
      return yield* Effect.fail(
        new UpdateInstallError({
          message: `Downloading ${description} returned status ${response.status}`,
        }),
      );
    }

    return yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: (cause: unknown) =>
        new UpdateInstallError({ message: `Failed to read ${description}`, cause }),
    });
  });
}

/**
 * Looks up an asset's expected digest in a `sha256sum`-format checksum file.
 *
 * `sha256sum` marks files it read in binary mode with a `*` before the name,
 * so the marker is stripped before matching.
 */
export function findExpectedChecksum(checksumFile: string, assetName: string): string | null {
  for (const line of checksumFile.split("\n")) {
    const [digest, name] = line.trim().split(/\s+/);
    if (digest && name && name.replace(/^\*/, "") === assetName) {
      return digest;
    }
  }
  return null;
}

/**
 * Replaces the running binary with `replacement`.
 *
 * The new binary is written beside the old one and moved over it, because a
 * rename within a directory is atomic and — unlike writing in place — is
 * allowed while the old binary is executing: the running process keeps its open
 * inode and the next launch gets the new file.
 */
function replaceRunningBinary(
  executablePath: string,
  replacement: Uint8Array,
): Effect.Effect<void, UpdateInstallError> {
  return Effect.try({
    try: () => {
      const stagingPath = path.join(
        path.dirname(executablePath),
        `.${path.basename(executablePath)}.update-${process.pid}`,
      );
      try {
        fs.writeFileSync(stagingPath, replacement, { mode: 0o755 });
        fs.renameSync(stagingPath, executablePath);
      } catch (cause) {
        fs.rmSync(stagingPath, { force: true });
        throw cause;
      }
    },
    catch: (cause: unknown) =>
      new UpdateInstallError({
        message:
          `Could not replace ${executablePath}.\n` +
          `Jazz needs write access to that directory. Re-run the installer, or\n` +
          `install somewhere you own:\n` +
          `  JAZZ_INSTALL_DIR="$HOME/.local/bin" \\\n` +
          `    curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh | bash`,
        cause,
      }),
  });
}

/**
 * Downloads the release binary for `version` and installs it over this one.
 *
 * @param version - Version to install, without a leading `v`.
 * @param terminal - Terminal used to report progress.
 */
export function installBinaryUpdate(
  version: string,
  terminal: TerminalService,
): Effect.Effect<void, UpdateInstallError> {
  return Effect.gen(function* () {
    const assetName = resolveReleaseAssetName();
    if (!assetName) {
      return yield* Effect.fail(
        new UpdateInstallError({
          message:
            `Jazz does not publish a binary for ${process.platform}/${process.arch}.\n` +
            `Install from npm instead: npm install -g jazz-ai@latest`,
        }),
      );
    }

    const releaseBase = `${RELEASE_DOWNLOAD_BASE}/v${version}`;
    yield* terminal.log(`\n📦 Downloading ${assetName} ${version}...`);

    const [archive, checksums] = yield* Effect.all(
      [
        fetchRelease(`${releaseBase}/${assetName}.gz`, assetName),
        fetchRelease(`${releaseBase}/${CHECKSUM_FILE}`, CHECKSUM_FILE),
      ],
      { concurrency: 2 },
    );

    const archiveBytes = new Uint8Array(archive);
    const expected = findExpectedChecksum(new TextDecoder().decode(checksums), `${assetName}.gz`);

    if (!expected) {
      return yield* Effect.fail(
        new UpdateInstallError({
          message: `Release ${version} has no checksum for ${assetName}.gz — refusing to install.`,
        }),
      );
    }

    const actual = createHash("sha256").update(archiveBytes).digest("hex");
    if (actual !== expected) {
      return yield* Effect.fail(
        new UpdateInstallError({
          message:
            `Checksum mismatch for ${assetName}.gz — refusing to install.\n` +
            `  expected ${expected}\n  actual   ${actual}`,
        }),
      );
    }

    const binary = yield* Effect.try({
      try: () => gunzipSync(archiveBytes),
      catch: (cause: unknown) =>
        new UpdateInstallError({ message: `Failed to decompress ${assetName}.gz`, cause }),
    });

    yield* terminal.log(`📦 Installing to ${process.execPath}...`);
    yield* replaceRunningBinary(process.execPath, binary);
  });
}
