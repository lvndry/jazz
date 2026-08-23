// Shared micro-benchmark harness. Benches run via `bun bench/<file>` (not
// `bun test`), so the test preload does not apply; pin the production glyph
// mode here so wrap widths match what users see.
process.env["JAZZ_UI_GLYPHS"] ??= "unicode";

export interface BenchOptions {
  readonly iterations?: number;
  readonly warmupIterations?: number;
}

export interface BenchResult {
  readonly name: string;
  readonly iterations: number;
  readonly totalMs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

const DEFAULT_ITERATIONS = Number(process.env["BENCH_ITERATIONS"] ?? 200);
const DEFAULT_WARMUP = Number(process.env["BENCH_WARMUP"] ?? 20);

export function bench(
  name: string,
  run: (iteration: number) => void,
  options: BenchOptions = {},
): BenchResult {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const warmupIterations = options.warmupIterations ?? DEFAULT_WARMUP;
  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    run(iteration);
  }
  const durations: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const start = performance.now();
    run(iteration);
    durations.push(performance.now() - start);
  }
  durations.sort((first, second) => first - second);
  const totalMs = durations.reduce((sum, value) => sum + value, 0);
  const percentile = (fraction: number): number =>
    durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))] ?? 0;
  return {
    name,
    iterations,
    totalMs: round(totalMs, 1),
    meanMs: round(totalMs / iterations, 4),
    p50Ms: round(percentile(0.5), 4),
    p95Ms: round(percentile(0.95), 4),
  };
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

// One aligned table for humans plus one JSON line per result for tooling
// (diffable across runs; `bench/run.ts` forwards both untouched).
export function report(suiteName: string, results: readonly BenchResult[]): void {
  const nameWidth = Math.max(...results.map((result) => result.name.length), 4);
  console.log(`\n== ${suiteName} ==`);
  console.log(
    `${"name".padEnd(nameWidth)}  ${"mean ms".padStart(9)}  ${"p50 ms".padStart(9)}  ${"p95 ms".padStart(9)}  iters`,
  );
  for (const result of results) {
    console.log(
      `${result.name.padEnd(nameWidth)}  ${result.meanMs.toFixed(4).padStart(9)}  ${result.p50Ms
        .toFixed(4)
        .padStart(9)}  ${result.p95Ms.toFixed(4).padStart(9)}  ${String(result.iterations)}`,
    );
  }
  for (const result of results) {
    console.log(JSON.stringify({ suite: suiteName, ...result }));
  }
}
