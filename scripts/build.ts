import fs from "node:fs";
import path from "node:path";
import manifest from "../package.json" with { type: "json" };
import { buildStandaloneBinary, COMPILE_TARGETS, NPM_PLATFORM_PACKAGES } from "./build-helpers";

/**
 * `bytecode: true` (set in build-helpers) needs ESM bytecode, added in Bun 1.4.
 * Checked here rather than via `engines.bun`, which Bun does not enforce —
 * and only here, since tests and the CLI from source still run on older Bun.
 */
const MINIMUM_BUN_VERSION = [1, 4] as const;

function assertBunSupportsBytecode(): void {
  const [major = 0, minor = 0] = Bun.version.split(".").map((part) => Number.parseInt(part, 10));
  const [requiredMajor, requiredMinor] = MINIMUM_BUN_VERSION;
  if (major > requiredMajor || (major === requiredMajor && minor >= requiredMinor)) return;
  throw new Error(
    `Compiling a binary needs Bun >= ${requiredMajor}.${requiredMinor} (found ${Bun.version}): ` +
      `ESM bytecode compilation is unavailable before it. Run \`bun upgrade\`.`,
  );
}

/**
 * Copies a compiled binary into its npm platform package (`deploy/npm/jazz-ai-<platform>/`)
 * and stamps that package's version to match the root manifest, so `npm publish`
 * run from that directory ships exactly this binary at exactly this version.
 *
 * @param compileTarget - A Bun target triple from {@link NPM_PLATFORM_PACKAGES}.
 * @param binaryPath - Path to the binary `buildStandaloneBinary` produced.
 */
function stageNpmPlatformPackage(compileTarget: string, binaryPath: string): void {
  const packageName = NPM_PLATFORM_PACKAGES[compileTarget as Bun.Build.CompileTarget];
  if (packageName === undefined) {
    throw new Error(`No npm platform package mapped for target "${compileTarget}".`);
  }

  const packageDir = path.join("deploy", "npm", packageName);
  const binDir = path.join(packageDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(binaryPath, path.join(binDir, "jazz"));
  fs.chmodSync(path.join(binDir, "jazz"), 0o755);

  const packageJsonPath = path.join(packageDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<
    string,
    unknown
  >;
  packageJson["version"] = manifest.version;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  process.stdout.write(`  staged ${packageName}@${manifest.version}\n`);
}

/**
 * Stamps `deploy/npm/jazz-ai`'s version and its optionalDependencies versions to
 * match the root manifest, and copies in the docs `files` references.
 * `deploy/npm/jazz-ai` never contains the binary itself — that only ever ships
 * inside the platform packages it depends on (see {@link stageNpmPlatformPackage}).
 */
function stageNpmMainPackage(): void {
  const packageDir = path.join("deploy", "npm", "jazz-ai");
  const packageJsonPath = path.join(packageDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    version: string;
    optionalDependencies: Record<string, string>;
    [key: string]: unknown;
  };

  packageJson.version = manifest.version;
  for (const dependencyName of Object.keys(packageJson.optionalDependencies)) {
    packageJson.optionalDependencies[dependencyName] = manifest.version;
  }
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  fs.copyFileSync("README.md", path.join(packageDir, "README.md"));
  fs.copyFileSync("LICENSE", path.join(packageDir, "LICENSE"));

  process.stdout.write(`  staged jazz-ai@${manifest.version}\n`);
}

/**
 * Stages every npm platform package from binaries that already exist on
 * disk, skipping the compile step. Lets the (Linux) publish job reuse the
 * macOS-signed binaries the (macOS) build job already produced, instead of
 * rebuilding unsigned copies.
 *
 * @param binariesDir - Directory containing one `jazz-<platform>` file per
 *   {@link COMPILE_TARGETS} entry, e.g. already-downloaded release assets.
 */
function stageNpmPackagesFromExistingBinaries(binariesDir: string): void {
  for (const target of Object.keys(COMPILE_TARGETS)) {
    const outputName = COMPILE_TARGETS[target as Bun.Build.CompileTarget] as string;
    const binaryPath = path.join(binariesDir, outputName);
    if (!fs.existsSync(binaryPath)) {
      throw new Error(`Expected a binary at ${binaryPath} — was it downloaded/extracted first?`);
    }
    stageNpmPlatformPackage(target, binaryPath);
  }
  stageNpmMainPackage();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const fromDirIndex = args.indexOf("--npm-packages-from-dir");
  if (fromDirIndex !== -1) {
    const binariesDir = args[fromDirIndex + 1];
    if (binariesDir === undefined) {
      throw new Error("--npm-packages-from-dir requires a directory argument.");
    }
    stageNpmPackagesFromExistingBinaries(binariesDir);
    return;
  }

  const explicitTargets = args
    .flatMap((arg, index) => (arg === "--target" ? [args[index + 1]] : []))
    .filter((target): target is string => target !== undefined);

  const targets = args.includes("--all-targets")
    ? Object.keys(COMPILE_TARGETS)
    : explicitTargets.length > 0
      ? explicitTargets
      : [`bun-${process.platform}-${process.arch}`];

  const stageNpm = args.includes("--npm-packages");

  assertBunSupportsBytecode();

  fs.mkdirSync(path.join("deploy", "binaries"), { recursive: true });
  for (const target of targets) {
    const binaryPath = await buildStandaloneBinary(target);
    if (stageNpm) stageNpmPlatformPackage(target, binaryPath);
  }

  if (stageNpm) stageNpmMainPackage();
}

await main();
