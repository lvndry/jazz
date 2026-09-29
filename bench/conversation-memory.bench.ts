/**
 * Isolated long-conversation memory measurements through each shipped renderer.
 * Every child warms a mounted tree, streams/finalizes successive 1k/10k/50k turns,
 * then samples retained heap after fullGC, external string/buffer memory and the
 * process RSS high-water mark. extraMemorySize is included in heapSize: do not add
 * them. The transient-cell sample counts garbage visible immediately before a
 * collection, not total allocations (automatic collections can hide churn).
 * Provider chunks yield in bounded groups and paint before the next group, so
 * React updates cannot queue up thousands of unpublished snapshots. Prose is
 * the realistic workload; the separately named short-paragraph case stresses
 * per-row caches. BENCH_MEMORY_TURNS accepts a comma-separated list; smoke
 * uses 100 prose turns and 30 stress turns; full uses 100,500 prose turns and
 * 100 stress turns. BENCH_MEMORY_TURNS=1000,5000 enables extended runs. Child
 * deadlines default to max(120s, turns*500ms), with a SIGKILL hard stop.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullGC, heapStats, memoryUsage } from "bun:jsc";
import { z } from "zod";
import { PROSE_PARAGRAPH } from "./corpus";
import { benchAsync, report, type BenchResult } from "./harness";
import { awaitPaint, mountPipeline, positiveLimit, type RendererKind } from "./ui-pipeline-fixture";
import { store } from "../packages/cli/src/ui/store";

type ParagraphShape = "prose" | "short-paragraphs";

const memoryObservation = z.object({
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
  turns: z.number().int().positive(),
});
type MemoryObservation = z.infer<typeof memoryObservation>;

async function worker(
  kind: RendererKind,
  turns: number,
  shape: ParagraphShape,
): Promise<MemoryObservation> {
  const pipeline = await mountPipeline(kind);
  let closed = false;
  try {
    pipeline.mutate(() => store.appendStream("response", "warmingMARK words\n\n"));
    await awaitPaint(pipeline, "warmingMARK");
    pipeline.mutate(() => store.clearOutputs());
    await pipeline.paint();
    fullGC();
    const before = heapStats();
    const baselineRss = memoryUsage();
    let sampledTransientCells = 0;
    const batch = positiveLimit("BENCH_MEMORY_BATCH", 25);
    const chunksPerFrame = positiveLimit("BENCH_MEMORY_CHUNKS_PER_FRAME", 64);
    for (let turn = 0; turn < turns; turn++) {
      const size = [1_000, 10_000, 50_000][turn % 3] ?? 1_000;
      const marker = `memoryMARK${turn}`;
      const paragraph =
        shape === "prose"
          ? `Turn ${turn}: ${PROSE_PARAGRAPH}`
          : `Turn ${turn}: 界 e\u0301 words and **bold** prose.\n\n`;
      const text = paragraph.repeat(Math.ceil(size / paragraph.length)).slice(0, size);
      pipeline.mutate(() => {
        store.printOutput({ type: "user", message: `question ${turn}`, timestamp: new Date(0) });
      });
      for (let group = 0; group < text.length; group += 128 * chunksPerFrame) {
        pipeline.mutate(() => {
          for (
            let offset = group;
            offset < Math.min(text.length, group + 128 * chunksPerFrame);
            offset += 128
          ) {
            store.appendStream("response", text.slice(offset, offset + 128));
          }
        });
        await Bun.sleep(0);
        await pipeline.paint();
      }
      pipeline.mutate(() => {
        store.appendStream("response", `\n\n${marker}\n\n`);
        store.finalizeStream();
      });
      if ((turn + 1) % batch === 0 || turn === turns - 1) {
        await awaitPaint(pipeline, marker);
        const liveCells = Object.values(heapStats().objectTypeCounts).reduce(
          (sum, count) => sum + count,
          0,
        );
        fullGC();
        sampledTransientCells += Math.max(0, liveCells - heapStats().objectCount);
      }
    }
    fullGC();
    const retained = heapStats();
    const peakRssBytes = memoryUsage().peak;
    pipeline.mutate(() => store.clearOutputs());
    await pipeline.paint();
    pipeline.mutate(() => store.appendStream("response", "clearMARK words\n\n"));
    await awaitPaint(pipeline, "clearMARK");
    pipeline.mutate(() => store.clearOutputs());
    await pipeline.paint();
    await Bun.sleep(50);
    await pipeline.paint();
    fullGC();
    const postClear = heapStats();
    const snapshotPath = process.env["BENCH_MEMORY_HEAP_SNAPSHOT"];
    if (snapshotPath) await Bun.write(snapshotPath, Bun.generateHeapSnapshot("v8", "arraybuffer"));
    const rendererOutputBytes = pipeline.outputBytes();
    await pipeline.close();
    closed = true;
    await Bun.sleep(0);
    fullGC();
    return {
      retainedHeapBytes: retained.heapSize - before.heapSize,
      retainedExtraMemoryBytes: retained.extraMemorySize - before.extraMemorySize,
      retainedCells: retained.objectCount - before.objectCount,
      postClearHeapBytes: postClear.heapSize - before.heapSize,
      postCloseHeapBytes: heapStats().heapSize - before.heapSize,
      peakRssBytes,
      baselineRssBytes: baselineRss.current,
      peakRssGrowthBytes: Math.max(0, peakRssBytes - baselineRss.peak),
      sampledTransientCells,
      rendererOutputBytes,
      turns,
    };
  } finally {
    if (!closed) await pipeline.close();
  }
}

if (process.argv[2] === "--worker") {
  const kind = process.argv[3];
  if (kind !== "ink" && kind !== "opentui") throw new Error("Unknown renderer");
  const turns = Number(process.argv[4]);
  const shape = process.argv[5];
  if (shape !== "prose" && shape !== "short-paragraphs") throw new Error("Unknown paragraph shape");
  if (!Number.isSafeInteger(turns) || turns < 1) throw new Error("Invalid turn count");
  console.log(JSON.stringify(await worker(kind, turns, shape)));
} else {
  const counts = (
    process.env["BENCH_MEMORY_TURNS"] ??
    (process.env["BENCH_PROFILE"] === "smoke" ? "100" : "100,500")
  )
    .split(",")
    .map(Number);
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 1))
    throw new Error("BENCH_MEMORY_TURNS must list positive integers");
  const results: BenchResult[] = [];
  for (const kind of ["opentui", "ink"] satisfies RendererKind[]) {
    for (const shape of ["prose", "short-paragraphs"] satisfies ParagraphShape[]) {
      for (const turns of shape === "prose"
        ? counts
        : [
            positiveLimit(
              "BENCH_MEMORY_STRESS_TURNS",
              process.env["BENCH_PROFILE"] === "smoke" ? 30 : 100,
            ),
          ]) {
        const home = await mkdtemp(join(tmpdir(), "jazz-memory-bench-"));
        try {
          let observation: MemoryObservation | undefined;
          const result = await benchAsync(
            `${kind} ${shape} ${turns} turns, isolated child lifetime`,
            async () => {
              const child = Bun.spawn(
                [process.execPath, import.meta.path, "--worker", kind, String(turns), shape],
                {
                  stdout: "pipe",
                  stderr: "pipe",
                  stdin: "ignore",
                  timeout: positiveLimit("BENCH_MEMORY_TIMEOUT_MS", Math.max(120_000, turns * 500)),
                  killSignal: "SIGKILL",
                  env: {
                    ...process.env,
                    JAZZ_HOME: home,
                    JAZZ_OFFLINE: "1",
                    JAZZ_DISABLE_KEYRING: "1",
                  },
                },
              );
              const [stdout, stderr, code] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
              ]);
              if (code !== 0) throw new Error(`Memory child exited ${code}: ${stderr}`);
              observation = memoryObservation.parse(JSON.parse(stdout.trim()));
              if (observation.turns !== turns) throw new Error("Invalid memory observation");
              console.error(
                `${kind} ${shape} ${turns} turns: peak RSS ${observation.peakRssBytes}, growth ${observation.peakRssGrowthBytes}, post-clear heap ${observation.postClearHeapBytes} bytes`,
              );
            },
            { iterations: 1, warmupIterations: 0 },
          );
          if (!observation) throw new Error("No memory observation returned");
          results.push({ ...result, metrics: { ...observation } });
        } finally {
          await rm(home, { recursive: true, force: true });
        }
      }
    }
  }
  report("conversation-memory", results);
}
