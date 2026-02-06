
import { spawnSync } from "child_process";
import fs from "fs";

function run(command: string[], opts?: { cwd?: string }) {
  console.log(`> ${command.join(" ")}`);
  const proc = spawnSync(command[0], command.slice(1), {
    stdio: "inherit",
    ...opts,
  });

  if (proc.error) {
    throw proc.error;
  }

  if (proc.status !== 0) {
    throw new Error(`Command failed with exit code ${proc.status}`);
  }
}

function main() {
  // Get target platform from environment variable or detect current platform
  const target = process.env.TARGET || detectPlatform();
  const outfile = "dist/jazz";

  // Ensure dist directory exists
  if (!fs.existsSync("dist")) {
    fs.mkdirSync("dist");
  }

  console.log(`Compiling Jazz CLI for ${target}...`);

  // Compile to standalone binary
  const buildArgs = [
    "bun",
    "build",
    "./src/entry.ts",
    "--compile",
    "--outfile",
    outfile,
    // Add external packages that might have binary dependencies or issues bundling
    "--external", "react",
    "--external", "ink",
    "--external", "ink-gradient",
    "--external", "cfonts",
    "--external", "ink-big-text",
    "--external", "pdf-parse",
  ];

  // Add target flag if specified
  if (target) {
    buildArgs.push("--target", `bun-${target}`);
  }

  run(buildArgs);

  console.log(`Successfully compiled to ${outfile}`);
}

function detectPlatform(): string {
  const platform = process.platform;
  const arch = process.arch;

  let platformName: string;
  let archName: string;

  switch (platform) {
    case "darwin":
      platformName = "darwin";
      break;
    case "linux":
      platformName = "linux";
      break;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }

  switch (arch) {
    case "x64":
      archName = "x64";
      break;
    case "arm64":
      archName = "arm64";
      break;
    default:
      throw new Error(`Unsupported architecture: ${arch}`);
  }

  return `${platformName}-${archName}`;
}

main();
