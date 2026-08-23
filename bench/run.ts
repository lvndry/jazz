// Runs every bench/*.bench.ts in its own process so module-level caches and
// JIT state never leak between suites. Usage:
//
//   bun run bench                 # everything
//   bun run bench transcript      # suites whose filename matches
import { readdirSync } from "node:fs";
import { join } from "node:path";

const benchDirectory = import.meta.dir;
const filter = process.argv[2];

const benchFiles = readdirSync(benchDirectory)
  .filter((fileName) => fileName.endsWith(".bench.ts"))
  .filter((fileName) => filter === undefined || fileName.includes(filter))
  .sort();

if (benchFiles.length === 0) {
  console.error(filter === undefined ? "No bench files found." : `No bench matches "${filter}".`);
  process.exitCode = 1;
} else {
  for (const fileName of benchFiles) {
    const child = Bun.spawnSync(["bun", join(benchDirectory, fileName)], {
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    if (child.exitCode !== 0) {
      process.exitCode = 1;
      console.error(`bench failed: ${fileName}`);
    }
  }
}
