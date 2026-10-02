/**
 * Focused UI ownership qualification tool. Requalifies the exact failing Ink
 * workloads from the 2026-10-01 UI ownership qualification in alternating,
 * isolated fresh-process base/head pairs, without discarding any observation.
 *
 * Run with Bun: `bun bench/qualify-ui.ts pipeline|memory --base <checkout> --head <checkout> --output <report>`.
 * Pipeline workers measure the same 1k-char, 20-turn, 120x40 fixtures as
 * `bench/ui-pipeline.bench.ts` — unicode and unbroken shapes — and report every
 * first delta (one frame) plus all 32 steady frames with the production
 * renderer scheduling of each checkout. Memory workers invoke the untouched
 * legacy `conversation-memory` short-paragraph Ink30 worker from each
 * checkout's own fixture; its GC, lifetime, source-retention and teardown
 * costs are included in the measured child wall time. Three base/head pairs
 * run base-first in each pair, and each reported number is the median of the
 * three fresh processes; the report preserves every original observation
 * alongside runtime and mode metadata so `scripts/performance-check.ts` can
 * compare the per-side `<output>.base.json` and `<output>.head.json` reports
 * by their `results` rows.
 *
 * Arguments are parsed and checked before any child is spawned: unknown
 * arguments, missing values, non-directory checkouts and missing fixture
 * files fail fast with a combined message. Children run through argument
 * arrays (never shell interpolation) with a fresh temporary `JAZZ_HOME`
 * passed as that variable, a pinned offline styled environment
 * (`FORCE_COLOR=3`, `NO_COLOR=''`) and production Unicode glyph widths;
 * every home is released on success and failure. Malformed or partial worker
 * JSON, mislabeled pipeline rows, summary statistics that contradict the
 * published durations, mismatched metric keys and nonzero child exit
 * statuses reject the run. No warmup is discarded and no budget threshold is
 * changed; the legacy checkout keeps its own fixture, so no production
 * compatibility shim is inserted.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

export const SAMPLE_PAIRS = 3;
const WORKER_TIMEOUT_MS = 120_000;

/** Rounding allowance per published frame: durations round to 4 decimals. */
const SUMMARY_ROUNDING_ALLOWANCE = 0.0001;

export type QualificationMode = "pipeline" | "memory";
export type QualificationSide = "base" | "head";

/** One measured frame or child lifetime, as reported by a worker process. */
export interface BenchRow {
  readonly suite: string;
  readonly name: string;
  readonly iterations: number;
  readonly totalMs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly metrics: Readonly<Record<string, number>>;
  readonly observedMs?: readonly number[];
}

/** The four exact pipeline workloads, in the order the worker publishes them. */
const PIPELINE_ROWS = [
  {
    name: "ink unicode 1000 chars, 20 turns, first delta -> painted frame",
    iterations: 1,
  },
  {
    name: "ink unicode 1000 chars, 20 turns, steady deltas -> painted frame",
    iterations: 32,
  },
  {
    name: "ink unbroken 1000 chars, 20 turns, first delta -> painted frame",
    iterations: 1,
  },
  {
    name: "ink unbroken 1000 chars, 20 turns, steady deltas -> painted frame",
    iterations: 32,
  },
] as const;

/** One fresh-process observation for one side of one alternating pair. */
export interface PairObservation {
  readonly pair: number;
  readonly side: QualificationSide;
  readonly rows: readonly BenchRow[];
}

/** Parsed and validated CLI input for the qualification runner. */
export interface QualificationCli {
  readonly mode: QualificationMode;
  readonly base: string;
  readonly head: string;
  readonly output: string;
}

/** Every rejection raised by validation, aggregation or worker parsing. */
export class QualificationError extends Error {}

const round = (value: number): number => Number(value.toFixed(4));

/** Median of a nonempty numeric sample; odd sample counts keep it a real observation. */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) throw new QualificationError("medianOf requires at least one value");
  return [...values].sort((first, second) => first - second)[Math.floor(values.length / 2)] ?? 0;
}

/** Summarize exact observed frame durations; no sample is discarded as warmup. */
export function summarizeRow(
  name: string,
  durations: readonly number[],
  metrics: Readonly<Record<string, number>>,
): BenchRow {
  if (durations.length === 0) throw new QualificationError(`No observed durations for ${name}`);
  if (durations.some((duration) => !Number.isFinite(duration) || duration < 0)) {
    throw new QualificationError(`Non-finite or negative duration observed for ${name}`);
  }
  const sorted = [...durations].sort((first, second) => first - second);
  const totalMs = durations.reduce((sum, duration) => sum + duration, 0);
  const percentile = (fraction: number): number =>
    round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0);
  return {
    suite: "ui-pipeline",
    name,
    iterations: durations.length,
    totalMs: round(totalMs),
    meanMs: round(totalMs / durations.length),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    metrics,
    observedMs: durations.map(round),
  };
}

/**
 * Parse the qualification CLI. The first positional must be the mode; `--base`,
 * `--head` and `--output` take exactly one value each. All argument problems
 * are reported together before anything is spawned.
 */
export function parseQualificationCli(argv: readonly string[]): QualificationCli {
  const problems: string[] = [];
  const expected =
    "Usage: bun bench/qualify-ui.ts pipeline|memory --base <checkout> --head <checkout> --output <report>";
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--base" || argument === "--head" || argument === "--output") {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || value.startsWith("--")) {
        problems.push(`${argument} requires a value`);
        continue;
      }
      if (options.has(argument)) problems.push(`${argument} is provided more than once`);
      else options.set(argument, value);
    } else if (argument.startsWith("--")) {
      problems.push(`Unknown argument: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  const mode = positional[0];
  if (positional.length > 1) problems.push("Unexpected positional argument");
  if (mode === undefined) problems.push(`Missing mode. ${expected}`);
  else if (mode !== "pipeline" && mode !== "memory")
    problems.push(`Unknown mode "${mode}". Expected pipeline or memory. ${expected}`);
  for (const key of ["--base", "--head", "--output"] as const) {
    if (!options.has(key)) problems.push(`Missing ${key}. ${expected}`);
  }
  if (problems.length > 0) throw new QualificationError(problems.join("; "));
  return {
    mode: mode as QualificationMode,
    base: resolve(options.get("--base") ?? ""),
    head: resolve(options.get("--head") ?? ""),
    output: resolve(options.get("--output") ?? ""),
  };
}

/**
 * Fixture files each mode requires in every checkout, resolved relative to
 * the checkout root. The pipeline worker imports the checkout's own fixture
 * and store; the memory worker runs the checkout's own conversation-memory
 * worker, which itself depends on the fixture, corpus and harness. The legacy
 * checkout therefore keeps its original fixture — no compatibility shim.
 */
export function requiredFixtureFiles(mode: QualificationMode): readonly string[] {
  return mode === "pipeline"
    ? ["bench/ui-pipeline-fixture.ts", "packages/cli/src/ui/store.ts"]
    : [
        "bench/conversation-memory.bench.ts",
        "bench/corpus.ts",
        "bench/harness.ts",
        "bench/ui-pipeline-fixture.ts",
      ];
}

/** Verify a checkout is a directory containing every fixture file the mode needs. */
export async function validateCheckout(
  label: string,
  checkout: string,
  mode: QualificationMode,
): Promise<void> {
  const problems: string[] = [];
  try {
    const info = await stat(checkout);
    if (!info.isDirectory()) problems.push(`${label} checkout is not a directory: ${checkout}`);
  } catch {
    problems.push(`${label} checkout does not exist: ${checkout}`);
  }
  for (const file of requiredFixtureFiles(mode)) {
    try {
      if ((await stat(join(checkout, file))).isFile() === false) {
        problems.push(`${label} checkout is missing ${file}`);
      }
    } catch {
      problems.push(`${label} checkout is missing ${file}`);
    }
  }
  if (problems.length > 0) throw new QualificationError(problems.join("; "));
}

/**
 * Argument-array spawn configuration for one worker child. No shell is
 * involved, so no path can be interpolated. The pinned environment matches a
 * real offline styled terminal: `FORCE_COLOR=3` with `NO_COLOR=''` keeps the
 * renderers' color output deterministic regardless of the caller's terminal,
 * and production Unicode glyph widths are selected explicitly.
 */
export function workerSpawnConfig(
  mode: QualificationMode,
  side: QualificationSide,
  cli: QualificationCli,
): {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
} {
  const checkout = side === "base" ? cli.base : cli.head;
  const command =
    mode === "pipeline"
      ? [process.execPath, import.meta.path, "--pipeline-worker", checkout]
      : [
          process.execPath,
          join(checkout, "bench/conversation-memory.bench.ts"),
          "--worker",
          "ink",
          "30",
          "short-paragraphs",
        ];
  return {
    command,
    cwd: checkout,
    env: {
      FORCE_COLOR: "3",
      NO_COLOR: "",
      JAZZ_OFFLINE: "1",
      JAZZ_DISABLE_KEYRING: "1",
      JAZZ_UI_GLYPHS: "unicode",
    },
  };
}

/**
 * The pipeline worker's published row contract. The metrics anchor the
 * pinned workload (1k chars, 20 turns, measured renderer output); extra
 * numeric keys stay permitted so a base worker from an older tree does not
 * fail on its own additional observations, but unknown non-numeric extras
 * reject the payload. The row's own top-level shape is strict: a renamed or
 * smuggled field is a protocol violation, not a new metric.
 */
const pipelineRowSchema = z
  .object({
    suite: z.literal("ui-pipeline"),
    name: z.string().min(1),
    iterations: z.number().int().positive(),
    totalMs: z.number().finite().nonnegative(),
    meanMs: z.number().finite().nonnegative(),
    p50Ms: z.number().finite().nonnegative(),
    p95Ms: z.number().finite().nonnegative(),
    metrics: z
      .object({
        historyTurns: z.literal(20),
        answerCharacters: z.literal(1_000),
        rendererOutputBytes: z.number().finite().nonnegative(),
      })
      .catchall(z.number().finite()),
    observedMs: z.array(z.number().finite().nonnegative()),
  })
  .strict();

/**
 * The legacy worker's published metric contract. Required keys anchor the
 * shape; extra numeric keys stay permitted so a base worker from an older
 * tree does not fail on its own additional observations, but unknown
 * non-numeric extras reject the payload.
 */
const memoryObservationSchema = z
  .object({
    retainedHeapBytes: z.number().finite(),
    retainedExtraMemoryBytes: z.number().finite(),
    retainedCells: z.number().finite(),
    postClearHeapBytes: z.number().finite(),
    postCloseHeapBytes: z.number().finite(),
    peakRssBytes: z.number().finite().positive(),
    baselineRssBytes: z.number().finite().positive(),
    peakRssGrowthBytes: z.number().finite().nonnegative(),
    sampledTransientCells: z.number().finite().nonnegative(),
    rendererOutputBytes: z.number().finite().positive(),
    turns: z.literal(30),
  })
  .catchall(z.number().finite());

/**
 * Validate a worker process's stdout as exactly the JSON rows (pipeline mode)
 * or exactly the memory observation (memory mode) the protocol publishes.
 * A partial or malformed payload rejects the whole run rather than reporting
 * a silently incomplete number. For pipeline rows, the claimed summary
 * statistics (total, mean, p50, p95) must agree with the published durations
 * within the per-frame rounding allowance: the gate compares the summary
 * fields, so an incoherent row cannot smuggle a false number into a report.
 */
export function parseWorkerOutput(
  mode: QualificationMode,
  stdout: string,
  wallMs: number,
): readonly BenchRow[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch (error) {
    throw new QualificationError(`Worker did not publish JSON: ${(error as Error).message}`);
  }
  if (mode === "memory") {
    const parsed = memoryObservationSchema.safeParse(value);
    if (!parsed.success) {
      throw new QualificationError(
        `Malformed memory worker result: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return [
      {
        suite: "conversation-memory",
        name: "ink short-paragraphs 30 turns, isolated child lifetime",
        iterations: 1,
        totalMs: wallMs,
        meanMs: wallMs,
        p50Ms: wallMs,
        p95Ms: wallMs,
        metrics: Object.fromEntries(Object.entries(parsed.data) as [string, number][]),
      },
    ];
  }
  const parsed = z.array(pipelineRowSchema).safeParse(value);
  if (!parsed.success) {
    throw new QualificationError(
      `Malformed pipeline worker rows: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const rows = parsed.data;
  if (rows.length !== PIPELINE_ROWS.length) {
    throw new QualificationError(
      `Expected ${PIPELINE_ROWS.length} pipeline rows, received ${rows.length}`,
    );
  }
  for (let index = 0; index < rows.length; index += 1) {
    const expected = PIPELINE_ROWS[index];
    const row = rows[index];
    if (expected === undefined || row === undefined) continue;
    if (row.name !== expected.name) {
      throw new QualificationError(
        `Pipeline row ${index} is "${row.name}", expected "${expected.name}"`,
      );
    }
    if (row.iterations !== expected.iterations) {
      throw new QualificationError(
        `Row "${row.name}" reports ${row.iterations} iterations, expected ${expected.iterations}`,
      );
    }
    if (row.observedMs.length !== expected.iterations) {
      throw new QualificationError(
        `Row "${row.name}" reports ${expected.iterations} iterations but ${
          row.observedMs.length
        } observed frames`,
      );
    }
    assertCoherentSummary(row);
  }
  return rows;
}

type PipelineSummaryRow = Pick<
  BenchRow,
  "name" | "totalMs" | "meanMs" | "p50Ms" | "p95Ms" | "observedMs"
> & {
  readonly observedMs: readonly number[];
};

/**
 * Verify a pipeline row's claimed summary statistics against its published
 * durations, allowing the per-frame 4-decimal rounding error (a 32-frame sum
 * may legitimately drift by at most 32 x 0.0001). A claim outside the
 * tolerance means the row is not what the observations say, so the run is
 * rejected rather than reporting an incoherent number.
 */
function assertCoherentSummary(row: PipelineSummaryRow): void {
  const observed = row.observedMs;
  if (observed.some((duration) => !Number.isFinite(duration) || duration < 0)) {
    throw new QualificationError(`Row "${row.name}" publishes a non-finite or negative duration`);
  }
  const tolerance = observed.length * SUMMARY_ROUNDING_ALLOWANCE;
  const sorted = [...observed].sort((first, second) => first - second);
  const total = observed.reduce((sum, duration) => sum + duration, 0);
  const percentile = (fraction: number): number =>
    round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0);
  const claims: ReadonlyArray<readonly ["totalMs" | "meanMs" | "p50Ms" | "p95Ms", number]> = [
    ["totalMs", total],
    ["meanMs", total / observed.length],
    ["p50Ms", percentile(0.5)],
    ["p95Ms", percentile(0.95)],
  ];
  for (const [field, implied] of claims) {
    if (Math.abs(row[field] - implied) > tolerance) {
      throw new QualificationError(
        `Row "${row.name}" claims ${field}=${row[field]} but its observed durations imply ` +
          `${round(implied)} (per-frame tolerance ${tolerance})`,
      );
    }
  }
}

/**
 * Aggregate the alternating fresh-process observations per side into the
 * median `results` rows. Every side must contribute exactly one fresh-process
 * sample for each pair 0, 1 and 2, and each sample must contain its own
 * complete, unique, name-aligned row set: a duplicate inside one pair cannot
 * supply a row missing from another. An unequal, duplicated or missing
 * sample rejects the report instead of reporting a silently biased median.
 * Metric key sets must also match exactly across the three samples so a
 * dropped or renamed metric cannot be silently median-filled with zero.
 */
export function aggregateObservations(
  mode: QualificationMode,
  side: QualificationSide,
  observations: readonly PairObservation[],
): readonly BenchRow[] {
  const samples = observations.filter((sample) => sample.side === side);
  const byPair = new Map<number, PairObservation[]>();
  for (const sample of samples) {
    byPair.set(sample.pair, [...(byPair.get(sample.pair) ?? []), sample]);
  }
  if (byPair.size !== SAMPLE_PAIRS) {
    throw new QualificationError(
      `Incomplete ${mode} ${side} observations: ${byPair.size} of ${SAMPLE_PAIRS} distinct pairs`,
    );
  }
  for (let pair = 0; pair < SAMPLE_PAIRS; pair += 1) {
    const count = byPair.get(pair)?.length ?? 0;
    if (count === 0) {
      throw new QualificationError(
        `Missing ${mode} ${side} sample for pair ${pair}: no fresh-process observation`,
      );
    }
    if (count > 1) {
      throw new QualificationError(
        `Duplicate ${mode} ${side} sample for pair ${pair}: ${count} observations, expected exactly 1`,
      );
    }
  }
  const ordered = [0, 1, 2].map((pair) => {
    const sample = byPair.get(pair)?.[0];
    if (!sample) {
      throw new QualificationError(`Missing ${mode} ${side} sample for pair ${pair}`);
    }
    return sample;
  });
  const [first] = ordered;
  if (!first) throw new QualificationError(`No ${mode} ${side} observations`);
  const names = first.rows.map((row) => row.name);
  if (names.length === 0) throw new QualificationError(`No ${mode} ${side} observations`);
  for (const sample of ordered) {
    const sampleNames = sample.rows.map((row) => row.name);
    if (sampleNames.length !== names.length || sampleNames.some((name) => !names.includes(name))) {
      throw new QualificationError(
        `Pair ${sample.pair} ${mode} ${side} sample rows do not match the complete row set`,
      );
    }
    if (new Set(sampleNames).size !== names.length) {
      throw new QualificationError(
        `Pair ${sample.pair} ${mode} ${side} sample contains duplicate rows`,
      );
    }
  }
  return names
    .map((name) => {
      const sampled = ordered.map((sample) => sample.rows.find((row) => row.name === name));
      const rows: BenchRow[] = [];
      for (const row of sampled) {
        if (row === undefined) {
          throw new QualificationError(
            `Missing ${mode} ${side} observation rows for "${name}": ${rows.length} of ${SAMPLE_PAIRS}`,
          );
        }
        rows.push(row);
      }
      const first = rows[0];
      if (first === undefined) return undefined;
      const metricKeys = Object.keys(first.metrics).sort();
      for (const sample of rows) {
        const keys = Object.keys(sample.metrics).sort();
        if (keys.length !== metricKeys.length || keys.some((key, i) => key !== metricKeys[i])) {
          throw new QualificationError(
            `Mismatched metric keys for ${mode} ${side} row "${first.name}": ` +
              `"${keys.join(", ") || "(none)"}" vs "${metricKeys.join(", ") || "(none)"}"`,
          );
        }
      }
      return {
        suite: first.suite,
        name: first.name,
        iterations: first.iterations,
        totalMs: round(medianOf(rows.map((sample) => sample.totalMs))),
        meanMs: round(medianOf(rows.map((sample) => sample.meanMs))),
        p50Ms: round(medianOf(rows.map((sample) => sample.p50Ms))),
        p95Ms: round(medianOf(rows.map((sample) => sample.p95Ms))),
        metrics: Object.fromEntries(
          metricKeys.map((key) => [
            key,
            round(medianOf(rows.map((sample) => sample.metrics[key] as number))),
          ]),
        ),
      };
    })
    .filter((row): row is BenchRow => row !== undefined);
}

/**
 * Write one side's qualification report. The report keeps runtime identity,
 * mode, the comparable per-side `results` (consumed by
 * `scripts/performance-check.ts`) and the full original `observations`.
 */
export async function writeSideReport(
  mode: QualificationMode,
  side: QualificationSide,
  outputPath: string,
  results: readonly BenchRow[],
  observations: readonly PairObservation[],
): Promise<void> {
  const report = {
    version: 1,
    samples: SAMPLE_PAIRS,
    mode,
    side,
    runtime: { platform: process.platform, arch: process.arch, bun: Bun.version },
    results: [...results],
    observations: [...observations],
  };
  await Bun.write(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

/**
 * The narrow contract the pipeline worker reads from a checkout's own fixture
 * and store. These are dynamic imports of arbitrary checkout code, validated
 * here at the module boundary so the worker body never touches `any`.
 */
interface WorkerPipelineHandle {
  mutate(change: () => void): void;
  paint(): Promise<string>;
  outputBytes(): number;
  close(): Promise<void>;
}
interface PipelineWorkerFixture {
  mountPipeline(kind: string): Promise<WorkerPipelineHandle>;
  seedHistory(turns: number): void;
  awaitPaint(pipeline: WorkerPipelineHandle, marker: string): Promise<unknown>;
}
interface PipelineWorkerStore {
  appendStream(kind: string, delta: string): void;
}
interface PipelineWorkerStoreModule {
  readonly store: PipelineWorkerStore;
}

/**
 * Run as the pipeline worker: `qualify-ui.ts --pipeline-worker <checkout>`.
 * Measures the checkout's own fixture — the same 1k-char, 20-turn, 120x40
 * unicode and unbroken shapes as `bench/ui-pipeline.bench.ts` — one first
 * delta plus 32 steady deltas each, and publishes the four rows as JSON on
 * stdout. The summary fields are derived from the published durations by
 * `summarizeRow`, so an emitted row is always coherent with its observations.
 * Everything else on stdout would corrupt the protocol, so the worker prints
 * nothing but the rows.
 */
async function runPipelineWorker(): Promise<void> {
  const checkout = process.argv[3];
  if (typeof checkout !== "string" || checkout.length === 0) {
    throw new QualificationError("Pipeline worker requires a checkout path");
  }
  const [fixtureModule, storeModule] = await Promise.all([
    import(join(checkout, "bench/ui-pipeline-fixture.ts")),
    import(join(checkout, "packages/cli/src/ui/store.ts")),
  ]);
  const fixture = fixtureModule as unknown as PipelineWorkerFixture;
  const store = (storeModule as unknown as PipelineWorkerStoreModule).store;
  if (
    typeof fixture.mountPipeline !== "function" ||
    typeof fixture.seedHistory !== "function" ||
    typeof fixture.awaitPaint !== "function" ||
    typeof store?.appendStream !== "function"
  ) {
    throw new QualificationError("Pipeline worker fixture or store is missing required exports");
  }
  const rows: BenchRow[] = [];
  for (const shape of ["unicode", "unbroken"] as const) {
    const pipeline = await fixture.mountPipeline("ink");
    try {
      const text =
        shape === "unicode"
          ? "界 e\u0301 👨‍👩‍👧‍👦 words ".repeat(Math.ceil(1_000 / 23)).slice(0, 1_000)
          : "x".repeat(1_000);
      pipeline.mutate(() => {
        fixture.seedHistory(20);
        store.appendStream("response", `${text}\nreadyMARK `);
      });
      await fixture.awaitPaint(pipeline, "readyMARK");
      for (const phase of [
        { name: "first delta", marker: "firstDeltaMARK", iterations: 1 },
        { name: "steady deltas", marker: "steadyDeltaMARK", iterations: 32 },
      ] as const) {
        const bytesBefore = pipeline.outputBytes();
        const durations: number[] = [];
        for (let iteration = 0; iteration < phase.iterations; iteration += 1) {
          const started = performance.now();
          const marker = `${phase.marker}${iteration}`;
          pipeline.mutate(() => store.appendStream("response", `\n${marker} words `));
          await fixture.awaitPaint(pipeline, marker);
          durations.push(performance.now() - started);
        }
        rows.push(
          summarizeRow(
            `ink ${shape} 1000 chars, 20 turns, ${phase.name} -> painted frame`,
            durations,
            {
              rendererOutputBytes: pipeline.outputBytes() - bytesBefore,
              historyTurns: 20,
              answerCharacters: 1_000,
            },
          ),
        );
      }
    } finally {
      await pipeline.close();
    }
  }
  console.log(JSON.stringify(rows));
}

/** Spawn one worker child, collect its output, and fail on a nonzero status. */
async function runWorker(mode: QualificationMode, cli: QualificationCli, side: QualificationSide) {
  const home = await mkdtemp(join(tmpdir(), "jazz-focused-qualification-"));
  try {
    const config = workerSpawnConfig(mode, side, cli);
    const started = performance.now();
    const child = Bun.spawn([...config.command], {
      cwd: config.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: WORKER_TIMEOUT_MS,
      env: { ...process.env, JAZZ_HOME: home, ...config.env },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const wallMs = round(performance.now() - started);
    if (code !== 0) {
      throw new QualificationError(
        `Focused ${mode} ${side} worker failed (${code}): ${stderr.slice(-1000)}`,
      );
    }
    return parseWorkerOutput(mode, stdout, wallMs);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const cli = parseQualificationCli(process.argv.slice(2));
  await validateCheckout("base", cli.base, cli.mode);
  await validateCheckout("head", cli.head, cli.mode);
  if (cli.base === cli.head) {
    throw new QualificationError(`base and head must be different checkouts: ${cli.base}`);
  }
  const observations: PairObservation[] = [];
  for (let pair = 0; pair < SAMPLE_PAIRS; pair += 1) {
    for (const side of ["base", "head"] as const) {
      const rows = await runWorker(cli.mode, cli, side);
      observations.push({ pair, side, rows });
      const summary =
        cli.mode === "memory"
          ? `${rows[0]?.totalMs.toFixed(1)} ms`
          : rows
              .map(
                (row) =>
                  `${row.name.includes("unicode") ? "unicode" : "unbroken"}/${row.iterations} p95=${row.p95Ms.toFixed(3)}`,
              )
              .join(", ");
      console.log(`${cli.mode} pair ${pair + 1} ${side}: ${summary} ms`);
    }
  }
  // Validate both sides before publishing either report: a mismatch
  // discovered on the head side must not leave a partial base report behind.
  // Nothing is written until both medians are assembled.
  const prepared: Array<readonly [QualificationSide, readonly BenchRow[]]> = [];
  for (const side of ["base", "head"] as const) {
    prepared.push([side, aggregateObservations(cli.mode, side, observations)]);
  }
  for (const [side, results] of prepared) {
    await writeSideReport(cli.mode, side, `${cli.output}.${side}.json`, results, observations);
  }
  console.log(`Reports written: ${cli.output}.base.json, ${cli.output}.head.json`);
}

// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Bun benchmark entry point.
if (import.meta.main) {
  try {
    if (process.argv[2] === "--pipeline-worker") {
      await runPipelineWorker();
    } else {
      await main();
    }
  } catch (error) {
    console.error(
      `Qualification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
