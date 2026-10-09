import fs from "node:fs";
import path from "node:path";
import { ensureNativeLibrariesForTarget } from "./compile-natives";

/**
 * Shared pieces of the standalone-binary build pipeline.
 *
 * `scripts/build.ts` is the user-facing entry point; `scripts/bundle-size.ts`
 * and `scripts/record-startup-order.ts` need the exact same plugins and asset
 * module to analyze or profile the same bundle, so the pipeline lives here.
 */

/**
 * Directories shipped alongside the code, in the order they are embedded.
 *
 * `vendor/` holds the macOS `terminal-notifier` app bundles and is embedded
 * only into macOS binaries; the others are platform-independent.
 */
export const ASSET_DIRECTORIES = ["personas", "skills"] as const;
export const DARWIN_ONLY_ASSET_DIRECTORIES = ["vendor"] as const;

/**
 * Release targets, mapped from Bun's target triple to the asset name the
 * install script looks for. Windows is deliberately absent: Jazz's scheduler
 * and notification paths have never been exercised there, and the install
 * script is POSIX-only.
 */
export const COMPILE_TARGETS: Readonly<Partial<Record<Bun.Build.CompileTarget, string>>> = {
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
export const NPM_PLATFORM_PACKAGES: Readonly<Partial<Record<Bun.Build.CompileTarget, string>>> = {
  "bun-darwin-arm64": "jazz-ai-darwin-arm64",
  "bun-darwin-x64": "jazz-ai-darwin-x64",
  "bun-linux-arm64": "jazz-ai-linux-arm64",
  "bun-linux-x64": "jazz-ai-linux-x64",
  "bun-linux-arm64-musl": "jazz-ai-linux-arm64-musl",
  "bun-linux-x64-musl": "jazz-ai-linux-x64-musl",
};

export const GENERATED_ASSETS_MODULE = ".build/embedded-assets.generated.ts";

/**
 * Recorded module-load order for bytecode compilation, produced by
 * `scripts/record-startup-order.ts` and applied by {@link buildStandaloneBinary}
 * when present. A file is only ever applied if the running Bun knows the
 * `bytecodeOrder` option; older releases ignore it, which keeps this a no-op
 * on stable.
 */
export const STARTUP_ORDER_FILE = ".build/startup.order";

export function isKnownCompileTarget(target: string): target is Bun.Build.CompileTarget {
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
export function createStandalonePlugins(generatedAssetsModule: string): import("bun").BunPlugin[] {
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
      /**
       * Neutralise `@photon-ai/advanced-imessage`'s peer preflight.
       *
       * Before opening a gRPC channel it calls `import.meta.resolve(peer)` for
       * each of nice-grpc, nice-grpc-common and @grpc/grpc-js, and refuses to
       * connect if any throws. A standalone binary has no node_modules to
       * resolve against, so that check always fails - even though the peers are
       * bundled and a static import of them works, which is how the real client
       * loads them.
       *
       * The check already skips itself where `import.meta.resolve` is
       * unavailable, so this flips that guard on rather than deleting the
       * function: inside the binary resolution genuinely is not available.
       */
      name: "jazz-photon-grpc-peer-preflight",
      setup(build) {
        build.onLoad({ filter: /@photon-ai\/advanced-imessage\/dist\/.*\.js$/ }, async (args) => {
          const source = await Bun.file(args.path).text();
          return {
            contents: source.replaceAll('typeof meta.resolve !== "function"', "true"),
            loader: "js",
          };
        });
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
export function generateEmbeddedAssetsModule(targetPlatform: string): string {
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
 * Applies a recorded module-load order (`.build/startup.order`, produced by
 * `scripts/record-startup-order.ts`) when present, so bytecode is compiled in
 * startup order instead of bundle order. Bun releases that predate
 * bytecode-ordering ignore the option, which keeps this a no-op there.
 *
 * @param compileTarget - A Bun target triple from {@link COMPILE_TARGETS}.
 * @returns Path to the compiled binary.
 */
export async function buildStandaloneBinary(compileTarget: string): Promise<string> {
  if (!isKnownCompileTarget(compileTarget)) {
    throw new Error(
      `Unknown target "${compileTarget}". Known targets: ${Object.keys(COMPILE_TARGETS).join(", ")}.`,
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

  const orderFile = fs.existsSync(STARTUP_ORDER_FILE)
    ? path.resolve(STARTUP_ORDER_FILE)
    : undefined;
  if (orderFile !== undefined) {
    process.stdout.write(`  bytecode order: ${STARTUP_ORDER_FILE}\n`);
  }

  const buildOptions: Parameters<typeof Bun.build>[0] & {
    bytecodeOrder?: string;
  } = {
    entrypoints: ["packages/runtime/src/entry.ts"],
    target: "bun",
    minify: true,
    splitting: true,
    format: "esm",
    bytecode: true,
    plugins: createStandalonePlugins(generatedAssets),
    compile: { target: compileTarget, outfile },
    // Bun releases without bytecode-ordering silently ignore the option.
    ...(orderFile === undefined ? {} : { bytecodeOrder: orderFile }),
  };
  const result = await Bun.build(buildOptions);

  if (!result.success) {
    for (const message of result.logs) process.stderr.write(`${message.message}\n`);
    throw new Error(`Compile failed for ${compileTarget}`);
  }

  const sizeInMegabytes = (fs.statSync(outfile).size / 1024 / 1024).toFixed(1);
  process.stdout.write(`  ${outputName}  ${sizeInMegabytes} MB\n`);
  return outfile;
}
