/**
 * Focused tests for the qualification tool's pure surface: CLI parsing,
 * malformed or partial worker payloads, incoherent summary statistics, and
 * unequal, duplicated or missing result samples. No worker process or
 * checkout directory is required.
 */
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  QualificationError,
  aggregateObservations,
  parseQualificationCli,
  parseWorkerOutput,
  summarizeRow,
  workerSpawnConfig,
  type BenchRow,
  type PairObservation,
} from "./qualify-ui";

const cli = parseQualificationCli([
  "pipeline",
  "--base",
  "/tmp/base",
  "--head",
  "/tmp/head",
  "--output",
  "/tmp/report",
]);

const STEADY_DURATIONS = Array.from({ length: 32 }, (_value, index) => 5 + index * 0.1);

/**
 * Build a coherent pipeline row with `summarizeRow` so the claimed summary
 * statistics always agree with the published durations; overrides make
 * deliberately malformed rows for rejection tests.
 */
function pipelineRow(
  shape: "unicode" | "unbroken",
  phase: "first delta" | "steady deltas",
  overrides: Partial<BenchRow> = {},
): BenchRow {
  const name = `ink ${shape} 1000 chars, 20 turns, ${phase} -> painted frame`;
  return {
    ...summarizeRow(name, phase === "first delta" ? [5.6] : STEADY_DURATIONS, {
      rendererOutputBytes: 12_345,
      historyTurns: 20,
      answerCharacters: 1_000,
    }),
    ...overrides,
  };
}

const pipelineWorkerJson = () =>
  JSON.stringify([
    pipelineRow("unicode", "first delta"),
    pipelineRow("unicode", "steady deltas"),
    pipelineRow("unbroken", "first delta"),
    pipelineRow("unbroken", "steady deltas"),
  ]);

describe("parseQualificationCli", () => {
  test("accepts pipeline and memory modes with resolved absolute paths", () => {
    expect(cli).toEqual({
      mode: "pipeline",
      base: expect.stringMatching(/\/tmp\/base$/),
      head: expect.stringMatching(/\/tmp\/head$/),
      output: expect.stringMatching(/\/tmp\/report$/),
    });
    expect(
      parseQualificationCli(["memory", "--base", "b", "--head", "h", "--output", "o"]).mode,
    ).toBe("memory");
  });

  test("rejects missing, unknown and duplicated arguments with a combined message", () => {
    expect(() => parseQualificationCli([])).toThrow(/Missing mode.*--base.*--head.*--output/s);
    expect(() =>
      parseQualificationCli(["profile", "--base", "b", "--head", "h", "--output", "o"]),
    ).toThrow('Unknown mode "profile"');
    expect(() => parseQualificationCli(["pipeline", "--base", "b", "--output", "o"])).toThrow(
      "--head",
    );
    expect(() => parseQualificationCli(["pipeline", "--head", "h", "--output", "o"])).toThrow(
      "--base",
    );
    expect(() => parseQualificationCli(["pipeline", "--base", "b", "--head", "h"])).toThrow(
      "--output",
    );
    expect(() =>
      parseQualificationCli(["pipeline", "--base", "b", "--head", "h", "--output"]),
    ).toThrow("--output requires a value");
    expect(() =>
      parseQualificationCli(["pipeline", "--base", "--head", "h", "--output", "o"]),
    ).toThrow("--base requires a value");
    expect(() =>
      parseQualificationCli([
        "pipeline",
        "--base",
        "b",
        "--head",
        "h",
        "--head",
        "x",
        "--output",
        "o",
      ]),
    ).toThrow("--head is provided more than once");
    expect(() =>
      parseQualificationCli([
        "pipeline",
        "--base",
        "b",
        "--head",
        "h",
        "--output",
        "o",
        "--samples",
        "3",
      ]),
    ).toThrow("Unknown argument: --samples");
    expect(() =>
      parseQualificationCli(["pipeline", "extra", "--base", "b", "--head", "h", "--output", "o"]),
    ).toThrow("Unexpected positional argument");
  });
});

describe("parseWorkerOutput", () => {
  test("accepts a complete pipeline payload and a validated memory observation", () => {
    const rows = parseWorkerOutput("pipeline", pipelineWorkerJson(), 30);
    expect(rows).toHaveLength(4);
    const memoryJson = JSON.stringify({
      retainedHeapBytes: 1_000,
      retainedExtraMemoryBytes: 500,
      retainedCells: 42,
      postClearHeapBytes: 300,
      postCloseHeapBytes: 250,
      peakRssBytes: 100_000_000,
      baselineRssBytes: 50_000_000,
      peakRssGrowthBytes: 12_000_000,
      sampledTransientCells: 100,
      rendererOutputBytes: 10_000,
      turns: 30,
      extraLegacyMetric: 7,
    });
    const memoryRows = parseWorkerOutput("memory", memoryJson, 412.345);
    expect(memoryRows).toHaveLength(1);
    expect(memoryRows[0]).toMatchObject({
      suite: "conversation-memory",
      name: "ink short-paragraphs 30 turns, isolated child lifetime",
      iterations: 1,
      totalMs: 412.345,
      p95Ms: 412.345,
      metrics: { turns: 30, extraLegacyMetric: 7 },
    });
  });

  test("allows extra numeric metric keys but rejects non-numeric extras", () => {
    const extraNumeric = JSON.parse(pipelineWorkerJson());
    extraNumeric[0].metrics.extraLegacyMetric = 7.5;
    const rows = parseWorkerOutput("pipeline", JSON.stringify(extraNumeric), 30);
    expect(rows[0]?.metrics).toMatchObject({ extraLegacyMetric: 7.5 });
    for (const extra of [null, "x", Number.NaN] as const) {
      const badExtra = JSON.parse(pipelineWorkerJson());
      badExtra[0].metrics.badExtra = extra;
      // NaN serializes to null in JSON, so both null and string extras
      // exercise the same non-numeric catchall rejection.
      expect(() => parseWorkerOutput("pipeline", JSON.stringify(badExtra), 30)).toThrow(
        "Malformed pipeline worker rows",
      );
    }
    const badMemory = JSON.stringify({
      retainedHeapBytes: 1_000,
      retainedExtraMemoryBytes: 500,
      retainedCells: 42,
      postClearHeapBytes: 300,
      postCloseHeapBytes: 250,
      peakRssBytes: 100_000_000,
      baselineRssBytes: 50_000_000,
      peakRssGrowthBytes: 12_000_000,
      sampledTransientCells: 100,
      rendererOutputBytes: 10_000,
      turns: 30,
      badExtra: "x",
    });
    expect(() => parseWorkerOutput("memory", badMemory, 1)).toThrow(
      "Malformed memory worker result",
    );
  });

  test("rejects malformed JSON, wrong turn count and unexpected pipeline shapes", () => {
    expect(() => parseWorkerOutput("pipeline", "{ not json", 1)).toThrow("did not publish JSON");
    expect(() => parseWorkerOutput("memory", "3.14", 1)).toThrow("Malformed memory worker result");
    const badTurns = JSON.stringify({
      retainedHeapBytes: 1,
      retainedExtraMemoryBytes: 1,
      retainedCells: 1,
      postClearHeapBytes: 1,
      postCloseHeapBytes: 1,
      peakRssBytes: 2,
      baselineRssBytes: 2,
      peakRssGrowthBytes: 1,
      sampledTransientCells: 1,
      rendererOutputBytes: 2,
      turns: 100,
    });
    expect(() => parseWorkerOutput("memory", badTurns, 1)).toThrow("turns");
    const wrongSuite = JSON.parse(pipelineWorkerJson());
    wrongSuite[0].suite = "other";
    expect(() => parseWorkerOutput("pipeline", JSON.stringify(wrongSuite), 1)).toThrow(
      "Malformed pipeline worker rows",
    );
    const missingKey = JSON.parse(pipelineWorkerJson());
    delete missingKey[0].p50Ms;
    expect(() => parseWorkerOutput("pipeline", JSON.stringify(missingKey), 1)).toThrow(
      "Malformed pipeline worker rows",
    );
    const negativeDuration = JSON.parse(pipelineWorkerJson());
    negativeDuration[1].observedMs[3] = -1;
    expect(() => parseWorkerOutput("pipeline", JSON.stringify(negativeDuration), 1)).toThrow(
      "Malformed pipeline worker rows",
    );
  });

  test("rejects partial or inconsistent pipeline rows", () => {
    const payload = JSON.parse(pipelineWorkerJson());
    expect(() => parseWorkerOutput("pipeline", JSON.stringify(payload.slice(0, 3)), 1)).toThrow(
      "Expected 4 pipeline rows, received 3",
    );
    const mismatch = JSON.parse(pipelineWorkerJson());
    mismatch[0].observedMs = [1, 2];
    expect(() => parseWorkerOutput("pipeline", JSON.stringify(mismatch), 1)).toThrow(
      "reports 1 iterations but 2 observed frames",
    );
    const wrongCount = JSON.parse(pipelineWorkerJson());
    wrongCount[1].observedMs = wrongCount[1].observedMs.slice(0, 31);
    expect(() => parseWorkerOutput("pipeline", JSON.stringify(wrongCount), 1)).toThrow(
      "reports 32 iterations but 31 observed frames",
    );
  });

  test("rejects summary statistics that contradict the published durations", () => {
    // observations [100ms, ...] with p95 = 0 used to parse; the boundary is
    // now as coherent as the worker itself.
    const zeroP95 = JSON.parse(pipelineWorkerJson());
    zeroP95[0].p95Ms = 0;
    expect(() => parseWorkerOutput("pipeline", JSON.stringify(zeroP95), 1)).toThrow(
      "claims p95Ms=0 but its observed durations imply 5.6",
    );
    const wrongMean = JSON.parse(pipelineWorkerJson());
    wrongMean[1].meanMs = 5.6;
    expect(() => parseWorkerOutput("pipeline", JSON.stringify(wrongMean), 1)).toThrow(
      "claims meanMs=5.6",
    );
    // A 32-frame sum may drift by up to 32 x 0.0001; both sides of that
    // tolerance are the boundary.
    const steady = JSON.parse(pipelineWorkerJson());
    steady[1].totalMs = 209.6 + 0.0031;
    expect(parseWorkerOutput("pipeline", JSON.stringify(steady), 1)).toHaveLength(4);
    steady[1].totalMs = 209.6 + 0.01;
    expect(() => parseWorkerOutput("pipeline", JSON.stringify(steady), 1)).toThrow(
      "claims totalMs=209.60999999999999 but its observed durations imply 209.6",
    );
  });
});

function pipelineObservations(rowsForPair: readonly BenchRow[][]): PairObservation[] {
  const observations: PairObservation[] = [];
  rowsForPair.forEach((rows, pair) => {
    for (const side of ["base", "head"] as const) observations.push({ pair, side, rows });
  });
  return observations;
}

describe("aggregateObservations", () => {
  test("reports the median of three fresh processes per side", () => {
    const make = (offset: number): BenchRow[] => [
      pipelineRow("unicode", "first delta", {
        totalMs: 2 + offset,
        meanMs: 2 + offset,
        p50Ms: 2 + offset,
        p95Ms: 2 + offset,
        observedMs: [2 + offset],
        metrics: { rendererOutputBytes: 1_000 + offset, historyTurns: 20, answerCharacters: 1_000 },
      }),
      pipelineRow("unicode", "steady deltas", {
        totalMs: 180 + offset,
        p50Ms: 5 + offset,
        p95Ms: 11.6 + offset,
        metrics: { rendererOutputBytes: 2_000 + offset, historyTurns: 20, answerCharacters: 1_000 },
      }),
    ];
    const results = aggregateObservations(
      "pipeline",
      "base",
      pipelineObservations([make(0), make(10_000), make(20_000)]),
    );
    expect(results).toHaveLength(2);
    // The odd count keeps the median a real observation, not an average.
    expect(results[0]).toMatchObject({
      iterations: 1,
      totalMs: 10_002,
      meanMs: 10_002,
      p50Ms: 10_002,
      p95Ms: 10_002,
    });
    expect(results[1]).toMatchObject({ totalMs: 10_180, p50Ms: 10_005, p95Ms: 10_011.6 });
    expect(results[0]?.metrics).toEqual({
      rendererOutputBytes: 11_000,
      historyTurns: 20,
      answerCharacters: 1_000,
    });
  });

  test("roundtrips extra numeric metric keys through the median", () => {
    const make = (offset: number): BenchRow[] => [
      pipelineRow("unicode", "first delta", {
        metrics: {
          rendererOutputBytes: 1_000,
          historyTurns: 20,
          answerCharacters: 1_000,
          extraLegacyMetric: 7 + offset,
        },
      }),
    ];
    const results = aggregateObservations(
      "pipeline",
      "base",
      pipelineObservations([make(0), make(1), make(2)]),
    );
    expect(results[0]?.metrics).toMatchObject({ extraLegacyMetric: 8 });
  });

  test("requires exactly one sample per pair 0, 1 and 2", () => {
    const complete = [pipelineRow("unicode", "first delta")];
    // Pair IDs 3, 4, 5 are three distinct samples, but not the required pairs.
    const shiftedPairs = pipelineObservations([complete, complete, complete]).map(
      (sample, index) => ({ ...sample, pair: index + 3 }),
    );
    expect(() => aggregateObservations("pipeline", "base", shiftedPairs)).toThrow(
      "Missing pipeline base sample for pair 0",
    );
    // Pair 0 twice plus pair 2 once is three samples, still incomplete.
    const duplicatedPair = [
      { pair: 0, side: "base" as const, rows: complete },
      { pair: 0, side: "base" as const, rows: complete },
      { pair: 2, side: "base" as const, rows: complete },
    ];
    expect(() => aggregateObservations("pipeline", "base", duplicatedPair)).toThrow(
      "2 of 3 distinct pairs",
    );
    // Two observations for one pair and none for another.
    const onePairTwice = [
      { pair: 0, side: "base" as const, rows: complete },
      { pair: 0, side: "base" as const, rows: complete },
      { pair: 1, side: "base" as const, rows: complete },
    ];
    // Only pairs 0 and 1 exist, so the pair-coverage check fires first;
    // the per-pair duplicate check is exercised with pairs 0, 1 and 2 present.
    expect(() => aggregateObservations("pipeline", "base", onePairTwice)).toThrow(
      "2 of 3 distinct pairs",
    );
    const allPairsOneDoubled = [
      { pair: 0, side: "base" as const, rows: complete },
      { pair: 0, side: "base" as const, rows: complete },
      { pair: 1, side: "base" as const, rows: complete },
      { pair: 2, side: "base" as const, rows: complete },
    ];
    expect(() => aggregateObservations("pipeline", "base", allPairsOneDoubled)).toThrow(
      "Duplicate pipeline base sample for pair 0: 2 observations, expected exactly 1",
    );
  });

  test("rejects unequal, missing and duplicate result rows", () => {
    const complete = [pipelineRow("unicode", "first delta")];
    const observations = pipelineObservations([complete, complete, complete]);
    expect(aggregateObservations("pipeline", "base", observations)).toHaveLength(1);
    // One side missing a whole pair.
    const missingPair = pipelineObservations([complete, complete]).concat({
      pair: 2,
      side: "head",
      rows: complete,
    });
    expect(() => aggregateObservations("pipeline", "base", missingPair)).toThrow(
      "2 of 3 distinct pairs",
    );
    // One side carrying an extra row in one pair breaks name alignment.
    const extraRow = pipelineObservations([
      complete,
      [complete[0]!, pipelineRow("unbroken", "first delta")],
      complete,
    ]);
    expect(() => aggregateObservations("pipeline", "base", extraRow)).toThrow(
      "Pair 1 pipeline base sample rows do not match the complete row set",
    );
    // A duplicate row inside one pair cannot supply a row missing elsewhere:
    // the pair itself is already malformed, and the name set still cannot be
    // aligned across all three samples.
    const duplicate = pipelineObservations([complete, [complete[0]!, complete[0]!], complete]);
    expect(() => aggregateObservations("pipeline", "base", duplicate)).toThrow(
      "Pair 1 pipeline base sample rows do not match the complete row set",
    );
    const intraPairDuplicate = pipelineObservations([
      [pipelineRow("unicode", "first delta"), pipelineRow("unicode", "first delta")],
      [pipelineRow("unicode", "first delta")],
      [pipelineRow("unicode", "first delta")],
    ]);
    expect(() => aggregateObservations("pipeline", "base", intraPairDuplicate)).toThrow(
      "Pair 0 pipeline base sample contains duplicate rows",
    );
  });

  test("rejects mismatched metric key sets across samples", () => {
    const complete = [pipelineRow("unicode", "first delta")];
    const renamed = [
      pipelineRow("unicode", "first delta", {
        metrics: { rendererOutputBytes: 1, historyTurns: 20 },
      }),
    ];
    const mismatched = pipelineObservations([complete, renamed, complete]);
    expect(() => aggregateObservations("pipeline", "base", mismatched)).toThrow(
      "Mismatched metric keys",
    );
  });

  test("rejects empty side observations and uneven row lists", () => {
    expect(() => aggregateObservations("memory", "head", [])).toThrow("0 of 3 distinct pairs");
    const uneven = pipelineObservations([
      [pipelineRow("unicode", "first delta"), pipelineRow("unicode", "steady deltas")],
      [pipelineRow("unicode", "first delta")],
      [pipelineRow("unicode", "first delta")],
    ]);
    expect(() => aggregateObservations("pipeline", "base", uneven)).toThrow(
      "Pair 1 pipeline base sample rows do not match the complete row set",
    );
  });
});

describe("workerSpawnConfig", () => {
  test("uses argument arrays for both modes with pinned worker environment", () => {
    const pipeline = workerSpawnConfig("pipeline", "base", cli);
    expect(pipeline.command).toEqual([
      process.execPath,
      join(import.meta.dir, "qualify-ui.ts"),
      "--pipeline-worker",
      cli.base,
    ]);
    expect(pipeline.cwd).toBe(cli.base);
    expect(pipeline.env).toEqual({
      FORCE_COLOR: "3",
      NO_COLOR: "",
      JAZZ_OFFLINE: "1",
      JAZZ_DISABLE_KEYRING: "1",
      JAZZ_UI_GLYPHS: "unicode",
    });
    const memory = workerSpawnConfig("memory", "head", cli);
    expect(memory.command).toEqual([
      process.execPath,
      `${cli.head}/bench/conversation-memory.bench.ts`,
      "--worker",
      "ink",
      "30",
      "short-paragraphs",
    ]);
    expect(memory.cwd).toBe(cli.head);
  });
});

describe("summarizeRow", () => {
  test("rejects empty and invalid duration samples", () => {
    expect(() => summarizeRow("empty", [], {})).toThrow("No observed durations");
    expect(() => summarizeRow("negative", [1, -0.5], {})).toThrow("Non-finite or negative");
    expect(() => summarizeRow("NaN", [1, Number.NaN], {})).toThrow("Non-finite or negative");
  });

  test("derives coherent summary statistics from the published durations", () => {
    const row = summarizeRow("steady", STEADY_DURATIONS, {});
    expect(row).toMatchObject({
      iterations: 32,
      totalMs: 209.6,
      meanMs: 6.55,
      p50Ms: 6.6,
      p95Ms: 8,
    });
    expect(row.observedMs).toHaveLength(32);
  });
});

describe("QualificationError", () => {
  test("is an Error instance so runner catch-all formatting works", () => {
    const error = new QualificationError("nope");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("nope");
  });
});
