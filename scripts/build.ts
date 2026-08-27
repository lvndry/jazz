import fs from "node:fs";
import path from "node:path";
import manifest from "../package.json" with { type: "json" };
import { ensureNativeLibrariesForTarget } from "./opentui-natives";

/**
 * Directories shipped alongside the code, in the order they are embedded.
 *
 * `vendor/` holds the macOS `terminal-notifier` app bundles and is embedded
 * only into macOS binaries; the others are platform-independent.
 */
const ASSET_DIRECTORIES = ["personas", "skills", "workflows"] as const;
const DARWIN_ONLY_ASSET_DIRECTORIES = ["vendor"] as const;

/**
 * Release targets, mapped from Bun's target triple to the asset name the
 * install script looks for. Windows is deliberately absent: Jazz's scheduler
 * and notification paths have never been exercised there, and the install
 * script is POSIX-only.
 */
const COMPILE_TARGETS: Readonly<Partial<Record<Bun.Build.CompileTarget, string>>> = {
  "bun-darwin-arm64": "jazz-darwin-arm64",
  "bun-darwin-x64": "jazz-darwin-x64",
  "bun-linux-arm64": "jazz-linux-arm64",
  "bun-linux-x64": "jazz-linux-x64",
  "bun-linux-arm64-musl": "jazz-linux-arm64-musl",
  "bun-linux-x64-musl": "jazz-linux-x64-musl",
};

/**
 * The same targets, mapped to the npm package that carries each platform's
 * binary as an optionalDependency of `jazz-ai` (see `deploy/npm/`). One
 * binary, two distribution channels — this just names where the compiled
 * output goes for the second one.
 */
const NPM_PLATFORM_PACKAGES: Readonly<Partial<Record<Bun.Build.CompileTarget, string>>> = {
  "bun-darwin-arm64": "jazz-ai-darwin-arm64",
  "bun-darwin-x64": "jazz-ai-darwin-x64",
  "bun-linux-arm64": "jazz-ai-linux-arm64",
  "bun-linux-x64": "jazz-ai-linux-x64",
  "bun-linux-arm64-musl": "jazz-ai-linux-arm64-musl",
  "bun-linux-x64-musl": "jazz-ai-linux-x64-musl",
};

const GENERATED_ASSETS_MODULE = ".build/embedded-assets.generated.ts";

function isKnownCompileTarget(target: string): target is Bun.Build.CompileTarget {
  return Object.hasOwn(COMPILE_TARGETS, target);
}

/**
 * The module a standalone build swaps in for `src/core/assets/embedded-assets`,
 * plus the packages that must be stubbed for the bundle to link at all.
 *
 * `react-devtools-core` is an uninstalled optional peer of ink, reachable only
 * from `ink/build/devtools.js`, which ink itself imports behind a `DEV=true`
 * check. Marking it external is not enough: the bundler hoists an external
 * dependency of a dynamically imported module to the top of the bundle, so the
 * binary fails on startup resolving a package it would never have used. The
 * same applies to `@x402/core/http`, the pay-per-request branch of `linkup-sdk`
 * that an API-key client never takes. Stubbing both keeps the dead branches
 * dead instead of fatal.
 */
function createStandalonePlugins(generatedAssetsModule: string): import("bun").BunPlugin[] {
  return [
    {
      name: "jazz-standalone-assets",
      setup(build) {
        build.onResolve({ filter: /^@\/core\/assets\/embedded-assets$/ }, () => ({
          path: path.resolve(generatedAssetsModule),
        }));
      },
    },
    {
      name: "jazz-stub-optional-imports",
      setup(build) {
        const stubbed = new RegExp(`^(${["react-devtools-core", "@x402/core/http"].join("|")})$`);
        build.onResolve({ filter: stubbed }, (args) => ({
          path: args.path,
          namespace: "jazz-stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "jazz-stub" }, () => ({
          contents: "export default {};",
          loader: "js",
        }));
      },
    },
  ];
}

/**
 * Writes the embedded-asset manifest for one target platform.
 *
 * Each asset becomes a `{ type: "file" }` import, which Bun copies into the
 * binary and resolves at runtime to a path inside the virtual filesystem.
 *
 * @param targetPlatform - Platform the binary is built for.
 * @returns Path to the generated module.
 */
function generateEmbeddedAssetsModule(targetPlatform: string): string {
  const directories = [
    ...ASSET_DIRECTORIES,
    ...(targetPlatform === "darwin" ? DARWIN_ONLY_ASSET_DIRECTORIES : []),
  ];

  const assets: { relativePath: string; executable: boolean }[] = [];
  for (const directory of directories) {
    for (const entry of new Bun.Glob("**/*").scanSync({ cwd: directory, onlyFiles: true })) {
      const relativePath = `${directory}/${entry.split(path.sep).join("/")}`;
      const mode = fs.statSync(relativePath).mode;
      assets.push({ relativePath, executable: (mode & 0o111) !== 0 });
    }
  }

  assets.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  if (assets.length === 0) {
    throw new Error(
      `No assets found in ${directories.join(", ")} — run the build from the repository root.`,
    );
  }

  const imports = assets.map(
    (asset, index) => `import asset${index} from "../${asset.relativePath}" with { type: "file" };`,
  );
  const entries = assets.map(
    (asset, index) =>
      `  { relativePath: ${JSON.stringify(asset.relativePath)}, sourcePath: asset${index}, executable: ${asset.executable} },`,
  );

  // The interface is repeated rather than imported: this module replaces
  // src/core/assets/embedded-assets, so importing from there would resolve
  // straight back to this file.
  const contents = [
    "// Generated by scripts/build.ts. Do not edit.",
    "export interface EmbeddedAssetFile {",
    "  readonly relativePath: string;",
    "  readonly sourcePath: string;",
    "  readonly executable: boolean;",
    "}",
    "",
    ...imports,
    "",
    "export const EMBEDDED_ASSET_FILES: readonly EmbeddedAssetFile[] = [",
    ...entries,
    "];",
    "",
  ].join("\n");

  fs.mkdirSync(path.dirname(GENERATED_ASSETS_MODULE), { recursive: true });
  fs.writeFileSync(GENERATED_ASSETS_MODULE, contents);
  return GENERATED_ASSETS_MODULE;
}

/**
 * Compiles one self-contained binary, assets and all.
 *
 * @param compileTarget - A Bun target triple from {@link COMPILE_TARGETS}.
 * @returns Path to the compiled binary.
 */
async function buildStandaloneBinary(compileTarget: string): Promise<string> {
  if (!isKnownCompileTarget(compileTarget)) {
    throw new Error(
      `Unknown target "${compileTarget}". Known targets: ${Object.keys(COMPILE_TARGETS).join(", ")}`,
    );
  }

  const outputName = COMPILE_TARGETS[compileTarget] as string;

  const targetPlatform = compileTarget.split("-")[1] ?? "";
  const generatedAssets = generateEmbeddedAssetsModule(targetPlatform);
  const outfile = path.join("deploy", "binaries", outputName);

  await ensureNativeLibrariesForTarget(compileTarget);

  // The bundler picks the JSX runtime from NODE_ENV at build time, and the
  // dev runtime (react/jsx-dev-runtime, jsxDEV) is unusable at runtime.
  process.env["NODE_ENV"] = "production";

  const result = await Bun.build({
    entrypoints: ["packages/runtime/src/entry.ts"],
    target: "bun",
    minify: true,
    plugins: createStandalonePlugins(generatedAssets),
    compile: { target: compileTarget, outfile },
  });

  if (!result.success) {
    for (const message of result.logs) process.stderr.write(`${message.message}\n`);
    throw new Error(`Compile failed for ${compileTarget}`);
  }

  const sizeInMegabytes = (fs.statSync(outfile).size / 1024 / 1024).toFixed(1);
  process.stdout.write(`  ${outputName}  ${sizeInMegabytes} MB\n`);
  return outfile;
}

/**
 * Copies a compiled binary into its npm platform package (`deploy/npm/jazz-ai-<platform>/`)
 * and stamps that package's version to match the root manifest, so `npm publish`
 * run from that directory ships exactly this binary at exactly this version.
 *
 * @param compileTarget - A Bun target triple from {@link NPM_PLATFORM_PACKAGES}.
 * @param binaryPath - Path to the binary {@link buildStandaloneBinary} produced.
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

  fs.mkdirSync(path.join("deploy", "binaries"), { recursive: true });
  for (const target of targets) {
    const binaryPath = await buildStandaloneBinary(target);
    if (stageNpm) stageNpmPlatformPackage(target, binaryPath);
  }

  if (stageNpm) stageNpmMainPackage();
}

await main();
