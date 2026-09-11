// Wall-clock process spawn: the one cost a microbench can't see is module
// graph evaluation, so this times whole `bun packages/runtime/src/main.ts
// --version` runs (the path #393 made skip the Effect app layer).
//
// This is the source path — what contributors and `bun run cli` pay, and the
// one that regresses when something heavy joins the eager import graph. It is
// NOT what a user sees: releases ship a `bun build --compile` binary, whose
// startup is dominated by loading an ~88MB executable rather than by
// evaluating modules (loading the entire Effect stack on top of `--version`
// adds ~40ms there, against ~100ms from source). Keep both in mind before
// reading a win here as a win for users.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bench, report } from "./harness";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const results = [
  bench(
    "bun packages/runtime/src/main.ts --version (spawn)",
    () => {
      const child = spawnSync("bun", [join("packages", "runtime", "src", "main.ts"), "--version"], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      if (child.status !== 0) throw new Error("--version exited non-zero");
    },
    { iterations: 8, warmupIterations: 2 },
  ),
];

report("startup", results);
