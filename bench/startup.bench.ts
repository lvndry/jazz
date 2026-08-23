// Wall-clock process spawn: the one cost a microbench can't see is module
// graph evaluation, so this times whole `bun src/main.ts --version` runs
// (the path #393 made skip the Effect app layer).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bench, report } from "./harness";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const results = [
  bench(
    "bun src/main.ts --version (spawn)",
    () => {
      const child = spawnSync("bun", ["src/main.ts", "--version"], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      if (child.status !== 0) throw new Error("--version exited non-zero");
    },
    { iterations: 8, warmupIterations: 2 },
  ),
];

report("startup", results);
