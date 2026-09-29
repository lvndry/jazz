/**
 * Run isolated benchmark suites and optionally collect their JSON rows. Use
 * `bun run bench [filter] --output report.json`; reports include runtime identity
 * so the regression checker can reject comparisons across different runtime environments.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchResult } from "./harness";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const samplesIndex = args.indexOf("--samples");
const samples = samplesIndex < 0 ? 1 : Number(args[samplesIndex + 1]);
if (!Number.isInteger(samples) || samples < 1 || samples > 9)
  throw new Error("--samples must be an integer between 1 and 9");
const outputPath = outputIndex < 0 ? undefined : args[outputIndex + 1];
if (outputIndex >= 0 && (outputPath === undefined || outputPath.startsWith("--"))) {
  throw new Error("--output requires a file path");
}
const filter = args.find(
  (arg, index) =>
    !arg.startsWith("--") &&
    (outputIndex < 0 || index !== outputIndex + 1) &&
    (samplesIndex < 0 || index !== samplesIndex + 1),
);
const benchDirectory = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(benchDirectory)
  .filter((name) => name.endsWith(".bench.ts") && (filter === undefined || name.includes(filter)))
  .sort();
const observations = new Map<string, (BenchResult & { suite: string })[]>();
if (files.length === 0) throw new Error(`No benchmarks match ${filter ?? "all"}`);
for (const file of files) {
  for (let sample = 0; sample < samples; sample += 1) {
    const child = spawnSync(process.execPath, [join(benchDirectory, file)], {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    process.stdout.write(child.stdout ?? "");
    process.stderr.write(child.stderr ?? "");
    if (child.status !== 0) {
      process.exitCode = 1;
      console.error(`Benchmark failed: ${file}: ${child.error?.message ?? String(child.status)}`);
    }
    let emittedRows = 0;
    for (const line of (child.stdout ?? "").split("\n")) {
      if (line.startsWith('{"suite":')) {
        emittedRows += 1;
        const row = JSON.parse(line) as BenchResult & { suite: string };
        const key = `${row.suite}/${row.name}`;
        const prior = observations.get(key) ?? [];
        prior.push(row);
        observations.set(key, prior);
      }
    }
    if (child.status === 0 && emittedRows === 0) {
      process.exitCode = 1;
      console.error(`Benchmark produced no result rows: ${file}`);
    }
  }
}
const median = (values: number[]): number =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const results = [...observations.values()].map((rows) => {
  const first = rows[0];
  if (first === undefined || rows.length !== samples)
    throw new Error("Incomplete benchmark samples");
  return {
    ...first,
    meanMs: median(rows.map((row) => row.meanMs)),
    p50Ms: median(rows.map((row) => row.p50Ms)),
    p95Ms: median(rows.map((row) => row.p95Ms)),
    totalMs: median(rows.map((row) => row.totalMs)),
    ...(first.metrics === undefined
      ? {}
      : {
          metrics: Object.fromEntries(
            Object.keys(first.metrics).map((key) => [
              key,
              median(
                rows.map((row) => {
                  const value = row.metrics?.[key];
                  if (value === undefined) throw new Error(`Missing benchmark metric ${key}`);
                  return value;
                }),
              ),
            ]),
          ),
        }),
  };
});
if (outputPath !== undefined) {
  writeFileSync(
    outputPath,
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
