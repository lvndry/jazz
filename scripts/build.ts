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
    "--external",
    "react",
    "--external",
    "ink",
    "--external",
    "pdf-parse",
    // Imported by linkup-sdk at runtime; bun can't resolve it for bundling.
    "--external",
    "@x402/core/http",
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

  const tsc = run(["bun", "run", "tsc", "--emitDeclarationOnly"]);
  if (tsc.stdout.length > 0) process.stdout.write(tsc.stdout);
  if (tsc.stderr.length > 0) process.stderr.write(tsc.stderr);
  if (tsc.exitCode !== 0) throw new Error(`TypeScript failed with exit code ${tsc.exitCode}`);
}

main();
