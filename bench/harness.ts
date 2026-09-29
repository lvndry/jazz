/**
 * Shared timing and reporting for isolated benchmark suites. Use bench for sync
 * work, benchAsync for asynchronous paths, and summarizeDurations for samples
 * whose cleanup must stay outside timing. report emits a table and JSON rows that
 * run.ts collects for budget checks. Run suites with `bun bench/<file>`; the test
 * preload does not apply, so this module pins production Unicode glyph widths.
 */
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
  /** Suite-specific numeric observations, such as retained heap bytes or output bytes. */
  readonly metrics?: Readonly<Record<string, number>>;
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
  return summarize(name, iterations, durations);
}

/** Summarize exact observed durations when lifecycle cleanup must stay outside timing. */
export function summarizeDurations(name: string, durations: readonly number[]): BenchResult {
  if (
    durations.length === 0 ||
    durations.some((duration) => !Number.isFinite(duration) || duration < 0)
  ) {
    throw new Error("Benchmark durations must be nonempty, finite and nonnegative");
  }
  return summarize(name, durations.length, [...durations]);
}

function summarize(name: string, iterations: number, durations: number[]): BenchResult {
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

/**
 * Async twin of `bench`, for paths that are only reachable through a promise
 * (a provider stream, a history scan). Identical accounting — the await is
 * inside the timed region, so provider-side waiting would show up here; the
 * suites that use it drive already-resolved data so it does not.
 */
export async function benchAsync(
  name: string,
  run: (iteration: number) => Promise<void>,
  options: BenchOptions = {},
): Promise<BenchResult> {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const warmupIterations = options.warmupIterations ?? DEFAULT_WARMUP;
  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    await run(iteration);
  }
  const durations: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const start = performance.now();
    await run(iteration);
    durations.push(performance.now() - start);
  }
  return summarize(name, iterations, durations);
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/** Emit a readable timing table and one machine-readable JSON result per row. */
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
