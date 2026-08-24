/**
 * @fileoverview Downloads the platform-specific `@opentui/core` libraries a
 * cross-compile needs.
 *
 * The fullscreen interface reaches a native Zig library that ships as one optional
 * dependency per platform, and an install only unpacks the one matching the machine
 * doing the installing — every other one is skipped by its `os`/`cpu` fields, however
 * explicitly it is asked for. The standalone build bundles `@opentui/core` rather than
 * leaving it external, so the bundler walks the platform switch inside it and has to
 * resolve the library for the target being compiled. Building `bun-linux-arm64` on an
 * x64 runner therefore failed on a package that is correctly absent, which took out
 * every non-native target in the release matrix.
 *
 * Fetching the tarball straight from the registry sidesteps the `os`/`cpu` gate that a
 * package manager is right to enforce. Bun imports the library as a file asset and
 * embeds it in the binary, so a foreign platform's copy is inert until it runs there.
 */

import fs from "node:fs";
import path from "node:path";

const REGISTRY_BASE_URL = process.env["npm_config_registry"] ?? "https://registry.npmjs.org";
const CORE_MANIFEST_PATH = "node_modules/@opentui/core/package.json";

/** The installed `@opentui/core`, which pins the version of each native package. */
export function readNativeVersions(): Record<string, string> {
  if (!fs.existsSync(CORE_MANIFEST_PATH)) {
    throw new Error(`${CORE_MANIFEST_PATH} is missing — run \`bun install\` before compiling.`);
  }
  const coreManifest = JSON.parse(fs.readFileSync(CORE_MANIFEST_PATH, "utf8")) as {
    optionalDependencies?: Record<string, string>;
  };
  return coreManifest.optionalDependencies ?? {};
}

/**
 * Which native packages the bundler will try to resolve for one compile target.
 *
 * Bun prunes the platform switch by the target's platform and architecture but not by
 * its libc, so a musl target and its glibc sibling each pull in both.
 *
 * @param compileTarget - A Bun target triple, e.g. `bun-linux-arm64-musl`.
 * @param availablePackages - Native package names to choose from; defaults to the ones
 *   the installed `@opentui/core` declares.
 */
export function nativePackagesForTarget(
  compileTarget: string,
  availablePackages: readonly string[] = Object.keys(readNativeVersions()),
): string[] {
  const [, platform, architecture] = compileTarget.split("-");
  if (platform === undefined || architecture === undefined) return [];
  const prefix = `@opentui/core-${platform}-${architecture}`;
  return availablePackages.filter((name) => name === prefix || name.startsWith(`${prefix}-`));
}

async function downloadNativePackage(packageName: string, version: string): Promise<void> {
  const installedPath = path.join("node_modules", ...packageName.split("/"));
  if (fs.existsSync(path.join(installedPath, "package.json"))) return;

  const bareName = packageName.split("/")[1] as string;
  const tarballUrl = `${REGISTRY_BASE_URL}/${packageName}/-/${bareName}-${version}.tgz`;
  const response = await fetch(tarballUrl);
  if (!response.ok) {
    throw new Error(`Could not download ${packageName}@${version}: HTTP ${response.status}`);
  }

  fs.mkdirSync(installedPath, { recursive: true });
  const archivePath = path.join(".build", `${bareName}-${version}.tgz`);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, new Uint8Array(await response.arrayBuffer()));

  const extraction = Bun.spawnSync(
    ["tar", "-xzf", archivePath, "-C", installedPath, "--strip-components=1"],
    { stdout: "pipe", stderr: "pipe" },
  );
  fs.rmSync(archivePath, { force: true });
  if (extraction.exitCode !== 0) {
    throw new Error(
      `Could not unpack ${packageName}@${version}: ${new TextDecoder().decode(extraction.stderr).trim()}`,
    );
  }
  process.stdout.write(`  fetched ${packageName}@${version}\n`);
}

/** Makes every native library the given target's bundle references resolvable. */
export async function ensureNativeLibrariesForTarget(compileTarget: string): Promise<void> {
  const versions = readNativeVersions();
  for (const packageName of nativePackagesForTarget(compileTarget, Object.keys(versions))) {
    const version = versions[packageName];
    if (version === undefined) continue;
    await downloadNativePackage(packageName, version);
  }
}
