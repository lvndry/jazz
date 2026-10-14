/**
 * Run isolated benchmark suites and optionally collect their JSON rows. Use
 * `bun run bench [filter] --output report.json`; reports include runtime identity
 * so the regression checker can reject comparisons across different runtime environments.
 *
 * `--base <checkout> --base-output base.json` measures another checkout in the
 * same run: each suite alternates base and head processes sample by sample,
 * swapping which side goes first, so runner drift lands on both sides of every
 * pair instead of on whichever side ran last. Every row keeps its per-sample
 * p50/p95 in pair order for `scripts/performance-check.ts`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchResult } from "./harness";

type SuiteRow = BenchResult & { suite: string };

interface Side {
  readonly root: string;
  readonly env: Readonly<Record<string, string>>;
  readonly observations: Map<string, SuiteRow[]>;
}

const args = process.argv.slice(2);
const flagsWithValues = ["--output", "--samples", "--base", "--base-output"];
function flagValue(flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
const samplesValue = flagValue("--samples");
const samples = samplesValue === undefined ? 1 : Number(samplesValue);
if (!Number.isInteger(samples) || samples < 1 || samples > 9) {
  throw new Error("--samples must be an integer between 1 and 9");
}
const outputPath = flagValue("--output");
const baseCheckout = flagValue("--base");
const baseOutputPath = flagValue("--base-output");
if ((baseCheckout === undefined) !== (baseOutputPath === undefined)) {
  throw new Error("--base and --base-output must be passed together");
}
const filter = args.find(
  (arg, index) => !arg.startsWith("--") && !flagsWithValues.includes(args[index - 1] ?? ""),
);

const benchDirectory = dirname(fileURLToPath(import.meta.url));
const head: Side = { root: resolve(benchDirectory, ".."), env: {}, observations: new Map() };
/**
 * The previous home menu did not accept typed drafts, so the base side skips
 * interactive startup readiness (see the startup section of bench/README.md).
 */
const base: Side | undefined =
  baseCheckout === undefined
    ? undefined
    : {
        root: resolve(baseCheckout),
        env: { BENCH_STARTUP_BASELINE: "1" },
        observations: new Map(),
      };

const files = readdirSync(benchDirectory)
  .filter((name) => name.endsWith(".bench.ts") && (filter === undefined || name.includes(filter)))
  .sort();
if (files.length === 0) {
  throw new Error(`No benchmarks match ${filter ?? "all"}`);
}

function runSuite(side: Side, file: string): void {
  const child = spawnSync(process.execPath, [join(side.root, "bench", file)], {
    cwd: side.root,
    encoding: "utf8",
    env: { ...process.env, ...side.env },
    maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  const label = side === head ? file : `${file} (base)`;
  if (child.status !== 0) {
    process.exitCode = 1;
    console.error(`Benchmark failed: ${label}: ${child.error?.message ?? String(child.status)}`);
  }
  let emittedRows = 0;
  for (const line of (child.stdout ?? "").split("\n")) {
    if (line.startsWith('{"suite":')) {
      emittedRows += 1;
      const row = JSON.parse(line) as SuiteRow;
      const key = `${row.suite}/${row.name}`;
      const prior = side.observations.get(key) ?? [];
      prior.push(row);
      side.observations.set(key, prior);
    }
  }
  if (child.status === 0 && emittedRows === 0) {
    process.exitCode = 1;
    console.error(`Benchmark produced no result rows: ${label}`);
  }
}

for (const file of files) {
  const sides =
    base !== undefined && existsSync(join(base.root, "bench", file)) ? [base, head] : [head];
  for (let sample = 0; sample < samples; sample += 1) {
    for (const side of sample % 2 === 0 ? sides : [...sides].reverse()) {
      runSuite(side, file);
    }
  }
}

const median = (values: number[]): number =>
  values.sort((first, second) => first - second)[Math.floor(values.length / 2)] ?? 0;

function writeReport(side: Side, path: string): void {
  const results = [...side.observations.values()].map((rows) => {
    const first = rows[0];
    if (first === undefined || rows.length !== samples) {
      throw new Error("Incomplete benchmark samples");
    }
    return {
      ...first,
      meanMs: median(rows.map((row) => row.meanMs)),
      p50Ms: median(rows.map((row) => row.p50Ms)),
      p95Ms: median(rows.map((row) => row.p95Ms)),
      totalMs: median(rows.map((row) => row.totalMs)),
      perSample: rows.map((row) => ({ p50Ms: row.p50Ms, p95Ms: row.p95Ms })),
      ...(first.metrics === undefined
        ? {}
        : {
            metrics: Object.fromEntries(
              Object.keys(first.metrics).map((key) => [
                key,
                median(
                  rows.map((row) => {
                    const value = row.metrics?.[key];
                    if (value === undefined) {
                      throw new Error(`Missing benchmark metric ${key}`);
                    }
                    return value;
                  }),
                ),
              ]),
            ),
          }),
    };
  });
  writeFileSync(
    path,
    JSON.stringify(
      {
        version: 1,
        samples,
        runtime: { platform: process.platform, arch: process.arch, bun: Bun.version },
        results,
      },
      null,
      2,
    ) + "\n",
  );
}

if (outputPath !== undefined) {
  writeReport(head, outputPath);
}
if (base !== undefined && baseOutputPath !== undefined) {
  writeReport(base, baseOutputPath);
}
