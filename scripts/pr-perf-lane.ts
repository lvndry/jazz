/**
 * Fast absolute-budget performance lane for pull requests:
 * `bun run bench:pr` locally, `bun run bench:pr --ci` on GitHub runners.
 * Builds the release binary, runs the startup, stream-processor and
 * transcript-rows suites (5 fresh-process samples, median), then checks every
 * row and the binary size against scripts/pr-perf-budgets.ts.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { LATENCY_BUDGETS, SIZE_BUDGETS } from "./pr-perf-budgets";
import {
  effectiveLatencyBudgetMs,
  latencyFailures,
  sizeFailures,
  type BudgetFailure,
  type MeasuredRow,
} from "./pr-perf-check";

const SUITES = ["startup", "stream-processor", "transcript-rows"] as const;
const SAMPLES = 5;
const REPRODUCE_COMMAND = "bun run bench:pr";

const root = resolve(import.meta.dir, "..");
const ciScale = process.argv.includes("--ci");

const benchEnvironment: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("BENCH_") && key !== "JAZZ_BENCH_BINARY",
  ),
);
Object.assign(benchEnvironment, {
  NO_COLOR: "",
  FORCE_COLOR: "3",
  JAZZ_OFFLINE: "1",
  BENCH_PROFILE: "smoke",
});

function run(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): void {
  const child = spawnSync(process.execPath, [...args], {
    cwd: root,
    stdio: "inherit",
    env: environment,
  });
  if (child.status !== 0) {
    console.error(`Step failed: bun ${args.join(" ")}`);
    process.exit(1);
  }
}

const startedAt = performance.now();
const reportDirectory = mkdtempSync(join(tmpdir(), "jazz-bench-pr-"));

console.log("== build release binary ==");
run(["run", "build:binary"]);

const rows: MeasuredRow[] = [];
for (const suite of SUITES) {
  console.log(`== ${suite} ==`);
  const output = join(reportDirectory, `${suite}.json`);
  run(["bench/run.ts", suite, "--samples", String(SAMPLES), "--output", output], benchEnvironment);
  const report = JSON.parse(readFileSync(output, "utf8")) as { results: MeasuredRow[] };
  rows.push(...report.results);
}

const failures: BudgetFailure[] = [...latencyFailures(rows, LATENCY_BUDGETS, ciScale)];

const platformKey = `${process.platform}-${process.arch}`;
const sizeBudget = SIZE_BUDGETS[platformKey];
if (sizeBudget === undefined) {
  failures.push({
    subject: "release binary",
    message: `no size budget for ${platformKey}; add one to SIZE_BUDGETS in scripts/pr-perf-budgets.ts`,
  });
} else {
  const binaryPath = join(root, "deploy", "binaries", `jazz-${platformKey}`);
  failures.push(
    ...sizeFailures(
      {
        binaryBytes: statSync(binaryPath).size,
        gzipBytes: gzipSync(readFileSync(binaryPath), { level: 9 }).length,
      },
      sizeBudget,
    ),
  );
}

console.log("\n== budgets ==");
for (const budget of LATENCY_BUDGETS) {
  const subject = `${budget.suite}/${budget.name}`;
  const row = rows.find(
    (candidate) => candidate.suite === budget.suite && candidate.name === budget.name,
  );
  const status = failures.some((failure) => failure.subject === subject) ? "FAIL" : "ok  ";
  const measured = row === undefined ? "missing" : `${row.p95Ms.toFixed(2)} ms`;
  console.log(
    `${status} ${subject}: p95 ${measured} (budget ${effectiveLatencyBudgetMs(budget, ciScale)} ms)`,
  );
}
console.log(`\nelapsed ${((performance.now() - startedAt) / 1000).toFixed(0)}s`);

if (failures.length > 0) {
  console.error(`\n${failures.length} performance budget(s) exceeded:`);
  for (const failure of failures) {
    console.error(`  - ${failure.message}`);
  }
  console.error(
    `\nReproduce locally: ${REPRODUCE_COMMAND}${ciScale ? " --ci" : ""}\n` +
      "Budgets are constants in scripts/pr-perf-budgets.ts. A local run without --ci uses reference-machine\n" +
      "values; pass --ci to apply the GitHub runner time scale. On a busy machine, rerun once before investigating.",
  );
  process.exit(1);
}
console.log("Performance budgets passed");
