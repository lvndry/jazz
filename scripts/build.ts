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
 */
const EXTERNAL_PACKAGES = ["ink", "pdf-parse", "react"] as const;

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

function main(): void {
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

main();
