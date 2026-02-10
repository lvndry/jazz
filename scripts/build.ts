type SpawnResult = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function run(command: string[], opts?: { readonly cwd?: string }): SpawnResult {
  const proc = Bun.spawnSync(command, {
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
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
    "ink-gradient",
    "--external",
    "cfonts",
    "--external",
    "ink-big-text",
    "--external",
    "pdf-parse",
    "--external",
    "js-tiktoken",
    "--banner",
    banner,
  ];

  const build = run(buildArgs);
  if (build.stdout.length > 0) process.stdout.write(build.stdout);
  if (build.stderr.length > 0) process.stderr.write(build.stderr);
  if (build.exitCode !== 0) throw new Error(`Build failed with exit code ${build.exitCode}`);

  const tsc = run(["bun", "run", "tsc", "--emitDeclarationOnly"]);
  if (tsc.stdout.length > 0) process.stdout.write(tsc.stdout);
  if (tsc.stderr.length > 0) process.stderr.write(tsc.stderr);
  if (tsc.exitCode !== 0) throw new Error(`TypeScript failed with exit code ${tsc.exitCode}`);
}

main();
