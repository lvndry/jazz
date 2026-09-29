/**
 * Compare machine-readable benchmark reports or release binaries. Benchmark
 * reports must share runtime identity; gates tolerate both proportional and
 * absolute noise. Run `bun scripts/performance-check.ts base.json head.json`
 * or add `--binary` to compare complete compiled artifacts (including natives).
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { z } from "zod";
const budgetDocument: unknown = JSON.parse(
  readFileSync(new URL("../bench/budgets.json", import.meta.url), "utf8"),
);

const budgets = z
  .object({
    latencyRelativeAllowance: z.number().nonnegative(),
    latencyNoiseMs: z.number().nonnegative(),
    binaryRelativeAllowance: z.number().nonnegative(),
    binaryNoiseBytes: z.number().nonnegative(),
    binaryMaxBytes: z.number().positive(),
    absolute: z.array(
      z.object({
        suite: z.string(),
        name: z.string().optional(),
        excludeNames: z.array(z.string()).optional(),
        maxP95Ms: z.number().positive().optional(),
        metrics: z.record(z.string(), z.number().nonnegative()).optional(),
      }),
    ),
  })
  .parse(budgetDocument);

const nonnegative = z.number().finite().nonnegative();
const rowSchema = z.object({
  suite: z.string(),
  name: z.string(),
  meanMs: nonnegative,
  p50Ms: nonnegative,
  p95Ms: nonnegative,
  metrics: z.record(z.string(), z.number().finite()).optional(),
});
const reportSchema = z.object({
  version: z.literal(1),
  runtime: z.object({ platform: z.string(), arch: z.string(), bun: z.string() }),
  results: z.array(rowSchema).min(1),
});
export type PerformanceReport = z.infer<typeof reportSchema>;

/** Fail a slowdown only when it exceeds both 30% and 0.5ms; never compare runtimes. */
export function regressions(base: PerformanceReport, head: PerformanceReport): readonly string[] {
  if (JSON.stringify(base.runtime) !== JSON.stringify(head.runtime)) {
    throw new Error("Performance reports have different runtime identities");
  }
  const prior = new Map(base.results.map((row) => [`${row.suite}/${row.name}`, row]));
  const failures: string[] = [];
  let compared = 0;
  for (const row of head.results) {
    const key = `${row.suite}/${row.name}`;
    const previous = prior.get(key);
    if (previous === undefined) continue;
    compared += 1;
    for (const metric of ["p50Ms", "p95Ms"] as const) {
      if (
        row[metric] > previous[metric] * (1 + budgets.latencyRelativeAllowance) &&
        row[metric] > previous[metric] + budgets.latencyNoiseMs
      ) {
        failures.push(`${key} ${metric}: ${previous[metric]} → ${row[metric]} ms`);
      }
    }
  }
  if (compared === 0) throw new Error("Reports have no comparable benchmark rows");
  return failures;
}

/** Enforce resource ceilings for new suites before a base measurement exists. */
export type AbsoluteBudget = (typeof budgets.absolute)[number];

export function absoluteRegressions(
  report: PerformanceReport,
  rules: readonly AbsoluteBudget[] = budgets.absolute,
): readonly string[] {
  const failures: string[] = [];
  for (const rule of rules) {
    const rows = report.results.filter(
      (row) =>
        row.suite === rule.suite &&
        (rule.name === undefined || row.name === rule.name) &&
        !(rule.excludeNames?.includes(row.name) ?? false),
    );
    if (rows.length === 0) {
      failures.push(`Missing budgeted workload: ${rule.suite}/${rule.name ?? "*"}`);
      continue;
    }
    for (const row of rows) {
      if (rule.maxP95Ms !== undefined && row.p95Ms > rule.maxP95Ms)
        failures.push(`${row.suite}/${row.name} exceeds ${rule.maxP95Ms} ms p95: ${row.p95Ms}`);
      for (const [metric, maximum] of Object.entries(rule.metrics ?? {})) {
        const value = row.metrics?.[metric];
        if (value === undefined || value > maximum)
          failures.push(
            `${row.suite}/${row.name} ${metric}: ${value ?? "missing"}, maximum ${maximum}`,
          );
      }
    }
  }
  return failures;
}

/** Enforce complete artifact growth and a 200MiB emergency cap, including gzip downloads. */
export function sizeRegressions(
  baseBytes: number,
  headBytes: number,
  label: string,
): readonly string[] {
  const failures: string[] = [];
  if (headBytes > budgets.binaryMaxBytes)
    failures.push(`${label} exceeds ${budgets.binaryMaxBytes} bytes: ${headBytes} bytes`);
  if (
    headBytes > baseBytes * (1 + budgets.binaryRelativeAllowance) &&
    headBytes > baseBytes + budgets.binaryNoiseBytes
  ) {
    failures.push(
      `${label} grew beyond ${(budgets.binaryRelativeAllowance * 100).toFixed(0)}% and ${budgets.binaryNoiseBytes} bytes: ${baseBytes} → ${headBytes} bytes`,
    );
  }
  return failures;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const binary = args[0] === "--binary";
  if (args[0] === "--absolute") {
    const path = args[1];
    if (path === undefined) throw new Error("Expected head report path");
    const failures = absoluteRegressions(
      reportSchema.parse(JSON.parse(readFileSync(path, "utf8"))),
    );
    failures.forEach((failure) => console.error(failure));
    process.exitCode = failures.length === 0 ? 0 : 1;
  } else {
    const [basePath, headPath] = binary ? args.slice(1) : args;
    if (basePath === undefined || headPath === undefined)
      throw new Error("Expected base and head paths");
    const failures = binary
      ? [
          ...sizeRegressions(statSync(basePath).size, statSync(headPath).size, "release binary"),
          ...sizeRegressions(
            gzipSync(readFileSync(basePath), { level: 9 }).length,
            gzipSync(readFileSync(headPath), { level: 9 }).length,
            "gzip download",
          ),
        ]
      : regressions(
          reportSchema.parse(JSON.parse(readFileSync(basePath, "utf8"))),
          reportSchema.parse(JSON.parse(readFileSync(headPath, "utf8"))),
        );
    for (const failure of failures) console.error(failure);
    console.log(
      failures.length === 0
        ? "Performance budgets passed"
        : `${failures.length} performance budgets failed`,
    );
    process.exitCode = failures.length === 0 ? 0 : 1;
  }
}
