import fs from "node:fs";
import path from "node:path";
import manifest from "../package.json" with { type: "json" };

type SpawnResult = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function run(
  command: string[],
  opts?: { readonly cwd?: string; readonly env?: Record<string, string | undefined> },
): SpawnResult {
  const proc = Bun.spawnSync(command, {
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    ...(opts?.env ? { env: opts.env } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

/**
 * Packages deliberately left out of dist/main.js, which makes them the only
 * packages a user of the published CLI has to download. Each one is here for a
 * different reason:
 *
 * - `ink` cannot be bundled. Its `build/devtools.js` has a top-level import of
 *   `react-devtools-core`, an optional peer dependency that Jazz does not
 *   install. Node never evaluates that module unless devtools are switched on,
 *   but a bundler has to resolve every static import it walks, so including ink
 *   fails the build outright on the missing specifier.
 * - `react` bundles without error, but must not be bundled. Since ink is
 *   external it loads react from node_modules, so a bundled copy would put two
 *   independent React instances in one process: Jazz's own components on the
 *   copy inside dist/main.js, and ink's reconciler on the installed copy. Hooks
 *   and context are per-instance state, so nothing rendered by ink would work.
 * - `pdf-parse` also bundles without error, and then fails when it runs. It
 *   loads `dist/worker/pdf.worker.mjs` from its own package directory at
 *   runtime, and depends on `@napi-rs/canvas`, whose `.node` file is a
 *   platform-specific native binary. Neither can be inlined into JavaScript.
 * - `@opentui/core` and `@opentui/react` render the fullscreen interface and
 *   cannot be bundled either. The core reaches a native Zig library through
 *   Bun's FFI, and that library ships as one optional dependency per platform
 *   (`@opentui/core-darwin-arm64` and friends), resolved at install time for
 *   the machine doing the installing. A bundler cannot inline a shared library
 *   it picks by platform, so both stay external and the package manager keeps
 *   doing the job it is good at.
 */
const EXTERNAL_PACKAGES = ["@opentui/core", "@opentui/react", "ink", "pdf-parse", "react"] as const;

/**
 * Not bundled and not installed either. `linkup-sdk`, the client behind the
 * Linkup web-search provider, reaches `@x402/core/http` through a dynamic
 * import on one branch: the one taken when the Linkup API answers HTTP 402 and
 * asks the caller to pay per request. Jazz authenticates with an API key and
 * never takes that branch, so the package is left uninstalled to save users the
 * download. It still has to be named here, because the bundler would otherwise
 * fail trying to resolve a specifier that is not present.
 */
const OPTIONAL_RUNTIME_IMPORTS = ["@x402/core/http"] as const;

/**
 * The external list above and `dependencies` in package.json describe the same
 * set from two directions, so they are checked against each other here.
 *
 * Drift in either direction is invisible during development, where every
 * package is installed regardless of which field it sits in. A bundled package
 * left in `dependencies` keeps working locally while making every user download
 * a copy of code that is already inside dist/main.js — which is how this list
 * previously grew to 57 entries and a 416 MB install. An external package
 * missing from `dependencies` is worse: the build succeeds and the published
 * CLI crashes on startup with an unresolved import.
 */
function resolveExternals(): string[] {
  const declared = Object.keys(manifest.dependencies).sort().join(", ");
  const external = [...EXTERNAL_PACKAGES].sort().join(", ");

  if (declared !== external) {
    throw new Error(
      [
        `"dependencies" in package.json must list exactly the packages that this`,
        `script excludes from the bundle, and right now it does not.`,
        ``,
        `  dependencies in package.json: ${declared || "(none)"}`,
        `  EXTERNAL_PACKAGES in scripts/build.ts: ${external}`,
        ``,
        `If you added a package that the bundle includes, move it to`,
        `"devDependencies" — leaving it in "dependencies" makes every user`,
        `download code that is already inside dist/main.js.`,
        ``,
        `If you added a package that genuinely cannot be bundled, add it to`,
        `EXTERNAL_PACKAGES above and explain there why it cannot be bundled.`,
      ].join("\n"),
    );
  }

  return [...EXTERNAL_PACKAGES, ...OPTIONAL_RUNTIME_IMPORTS];
}

function buildNpmBundle(): void {
  const banner = "#!/usr/bin/env node";
  const outfile = "dist/main.js";

  const buildArgs = [
    "bun",
    "build",
    "src/entry.ts",
    "--outfile",
    outfile,
    "--target",
    "node",
    "--minify",
    ...resolveExternals().flatMap((dependency) => ["--external", dependency]),
    "--banner",
    banner,
  ];

  // NODE_ENV=production makes bun emit the production automatic JSX runtime
  // (react/jsx-runtime jsx/jsxs) instead of the dev runtime (react/jsx-dev-runtime
  // jsxDEV). The dev runtime breaks a clean install of the published package: at
  // runtime NODE_ENV is production, so React serves its production jsx-dev-runtime
  // where jsxDEV is not a usable export → "jsxDEV is not a function" at load.
  const build = run(buildArgs, { env: { ...process.env, NODE_ENV: "production" } });
  if (build.stdout.length > 0) process.stdout.write(build.stdout);
  if (build.stderr.length > 0) process.stderr.write(build.stderr);
  if (build.exitCode !== 0) throw new Error(`Build failed with exit code ${build.exitCode}`);

  const tsc = run(["bunx", "tsc", "--emitDeclarationOnly", "-p", "tsconfig.app.json"]);
  if (tsc.stdout.length > 0) process.stdout.write(tsc.stdout);
  if (tsc.stderr.length > 0) process.stderr.write(tsc.stderr);
  if (tsc.exitCode !== 0) throw new Error(`TypeScript failed with exit code ${tsc.exitCode}`);
}

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
  const outfile = path.join("binaries", outputName);

  // Matches the reasoning in buildNpmBundle: the bundler picks the JSX runtime
  // from NODE_ENV at build time, and the dev runtime is unusable at runtime.
  process.env["NODE_ENV"] = "production";

  const result = await Bun.build({
    entrypoints: ["src/entry.ts"],
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (!args.includes("--compile")) {
    buildNpmBundle();
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

  fs.mkdirSync("binaries", { recursive: true });
  for (const target of targets) {
    await buildStandaloneBinary(target);
  }
}

await main();
