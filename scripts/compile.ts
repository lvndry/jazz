
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
  const outfile = "dist/jazz";

  // Ensure dist directory exists
  if (!fs.existsSync("dist")) {
    fs.mkdirSync("dist");
  }

  console.log("Compiling Jazz CLI...");

  // Compile to standalone binary
  // We explicitly target bun-darwin-arm64 for standard Apple Silicon macs by default
  // Ideally this should be configurable or auto-detected based on the host if building locally
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

  run(buildArgs);

  console.log(`Successfully compiled to ${outfile}`);
}

main();
