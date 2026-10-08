/**
 * @fileoverview Downloads the platform-specific native libraries a
 * cross-compile needs.
 *
 * The bundle pulls in native packages that ship as one optional dependency per
 * platform (the @opentui/core fullscreen UI, @resvg/resvg-js for OG cards, …).
 * An install only unpacks the one matching the machine doing the installing —
 * every other one is skipped by its `os`/`cpu` fields, however explicitly it is
 * asked for. The standalone build bundles rather than leaving these external,
 * so the bundler walks each package's platform switch and has to resolve the
 * library for the target being compiled. Building `bun-linux-arm64` on an x64
 * runner therefore fails on a package that is correctly absent, which took out
 * every non-native target in the release matrix.
 *
 * Fetching the tarball straight from the registry sidesteps the `os`/`cpu` gate
 * that a package manager is right to enforce. Bun imports the library as a file
 * asset and embeds it in the binary, so a foreign platform's copy is inert
 * until it runs there.
 *
 * Which packages to fetch is not a hard-coded list: the root and every
 * workspace's node_modules are scanned for packages that declare
 * `optionalDependencies` shaped like `<own-name>-<platform>-<arch>[-suffix]`,
 * and those are the ones a cross-compile must resolve. A new native dependency
 * needs no change here.
 */

import fs from "node:fs";
import path from "node:path";

const REGISTRY_BASE_URL = process.env["npm_config_registry"] ?? "https://registry.npmjs.org";

/**
 * The node_modules directories that hold installed packages: the root plus one
 * per workspace. The package manager may hoist a dependency to the root or
 * keep it nested next to its importer, and either placement is a valid
 * provider — both must be scanned.
 */
function nodeModulesDirs(): string[] {
  const dirs = ["node_modules"];
  for (const workspace of ["packages", "plugins"]) {
    const entries = fs.existsSync(workspace)
      ? fs.readdirSync(workspace, { withFileTypes: true })
      : [];
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(`${workspace}/${entry.name}/node_modules`);
    }
  }
  return dirs;
}

/**
 * The native optionalDependencies of the package at `packageDir`: the entries
 * that carry the package's own name, e.g. @resvg/resvg-js declares
 * @resvg/resvg-js-darwin-x64. Empty when the directory holds no manifest.
 */
function nativeOptionalDependencies(
  packageName: string,
  packageDir: string,
): Record<string, string> {
  const manifestPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(manifestPath)) return {};
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    optionalDependencies?: Record<string, string>;
  };
  const declared = manifest.optionalDependencies ?? {};
  return Object.fromEntries(
    Object.entries(declared).filter(
      ([name]) => name === packageName || name.startsWith(`${packageName}-`),
    ),
  );
}

/**
 * Every installed package that ships per-platform native optional dependencies,
 * across every node_modules. Keyed by package name; all copies of a package
 * pin the same native version, so the first one seen is enough.
 */
function nativeShimProviders(): Record<string, Record<string, string>> {
  const providers: Record<string, Record<string, string>> = {};
  for (const nodeModules of nodeModulesDirs()) {
    if (!fs.existsSync(nodeModules)) continue;
    for (const entry of fs.readdirSync(nodeModules)) {
      if (entry.startsWith(".")) continue;
      const scopePath = path.join(nodeModules, entry);
      const names = entry.startsWith("@")
        ? fs
            .readdirSync(scopePath)
            .filter((child) => fs.statSync(path.join(scopePath, child)).isDirectory())
            .map((child) => `${entry}/${child}`)
        : [entry];
      for (const name of names) {
        if (providers[name] !== undefined) continue;
        const declared = nativeOptionalDependencies(name, path.join(nodeModules, name));
        if (Object.keys(declared).length > 0) providers[name] = declared;
      }
    }
  }
  return providers;
}

/**
 * The native packages a compiled binary needs, keyed by package name, for
 * every provider. The key matters: the same bare name resolves to a different
 * version per provider.
 */
export function readNativeVersions(): Record<string, Record<string, string>> {
  const providers = nativeShimProviders();
  if (Object.keys(providers).length === 0) {
    throw new Error(
      `No native shim packages found in any node_modules — run \`bun install\` before compiling.`,
    );
  }
  return providers;
}

/**
 * Does `name` carry the target's platform and architecture right after the
 * provider's own name? The platform must sit directly after
 * `<provider>-`: `resvg-js-darwin-x64` qualifies for darwin-x64, but
 * `resvg-js-android-arm64` must not qualify for a darwin-arm64 target just
 * because its arch matches.
 */
function matchesTarget(
  provider: string,
  name: string,
  platform: string,
  architecture: string,
): boolean {
  const platformArchitecture = `${platform}-${architecture}`;
  const suffix = name.slice(provider.length + 1); // after "<provider>-"
  return suffix === platformArchitecture || suffix.startsWith(`${platformArchitecture}-`);
}

/**
 * Which native packages the bundler will try to resolve for one compile target.
 *
 * Bun prunes the platform switch by the target's platform and architecture but
 * not by its libc, so a musl target and its glibc sibling each pull in both
 * linux variants.
 *
 * @param compileTarget - A Bun target triple, e.g. `bun-linux-arm64-musl`.
 * @param providers - Provider -> declared natives, as readNativeVersions()
 *   returns them; defaults to what is installed.
 */
export function nativePackagesForTarget(
  compileTarget: string,
  providers: Record<string, Record<string, string>> = readNativeVersions(),
): string[] {
  const [, platform, architecture] = compileTarget.split("-");
  if (platform === undefined || architecture === undefined) return [];
  const result: string[] = [];
  for (const [provider, declared] of Object.entries(providers)) {
    for (const name of Object.keys(declared)) {
      if (matchesTarget(provider, name, platform, architecture)) result.push(name);
    }
  }
  return result;
}

/** The union of every provider's declared natives, versioned. */
export function flattenProviders(
  providers: Record<string, Record<string, string>>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const declared of Object.values(providers)) {
    for (const [name, version] of Object.entries(declared)) {
      if (merged[name] === undefined) merged[name] = version;
    }
  }
  return merged;
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
    {
      stdout: "pipe",
      stderr: "pipe",
    },
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
  const providers = readNativeVersions();
  const available = flattenProviders(providers);
  for (const packageName of nativePackagesForTarget(compileTarget, providers)) {
    const version = available[packageName];
    if (version === undefined) continue;
    await downloadNativePackage(packageName, version);
  }
}
