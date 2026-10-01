/**
 * Store-to-terminal frame latency for both shipped React renderers, including
 * long histories, sustained provider deltas, the real pacing timer, and resize.
 * OpenTUI timings include React commits, native ANSI writes, and confirmation
 * that the marker reached the painted frame. Ink includes its production frame
 * throttle and completed stdout writes. Both use isolated terminal streams.
 * BENCH_PROFILE=smoke bounds samples while preserving all answer-size cases.
 * Each provider-delta case reports the first delta after the ready frame
 * separately from sustained deltas. Every delta is measured: there is no
 * discarded warmup. Smoke uses 32 sustained frames so p50 and p95 no longer
 * both describe the slower of two startup frames. Buffer, pacing, and resize
 * cases retain their independent sample counts and existing budget rules.
 */
import { Effect } from "effect";
import { markdownReply, PROSE_PARAGRAPH } from "./corpus";
import { benchAsync, report, type BenchResult } from "./harness";
import {
  awaitPaint,
  mountPipeline,
  positiveLimit,
  seedHistory,
  type RendererKind,
} from "./ui-pipeline-fixture";
import { InkStreamingRenderer } from "../packages/cli/src/presentation/ink-presentation-service";
import { store } from "../packages/cli/src/ui/store";
import { DEFAULT_DISPLAY_CONFIG } from "../packages/core/src/agent/types";

const smoke = process.env["BENCH_PROFILE"] === "smoke";
const frames = positiveLimit("BENCH_PIPELINE_FRAMES", smoke ? 2 : 12);
const deltaFrames = positiveLimit("BENCH_PIPELINE_DELTA_FRAMES", smoke ? 32 : 64);
const historyTurns = positiveLimit("BENCH_PIPELINE_HISTORY", smoke ? 20 : 300);
const results: BenchResult[] = [];

for (const kind of ["opentui", "ink"] satisfies RendererKind[]) {
  for (const size of [1_000, 10_000, 50_000]) {
    for (const shape of ["prose", "unicode", "unbroken"] as const) {
      const pipeline = await mountPipeline(kind);
      try {
        const text =
          shape === "prose"
            ? markdownReply(size).slice(0, size)
            : shape === "unicode"
              ? "界 e\u0301 👨‍👩‍👧‍👦 words ".repeat(Math.ceil(size / 23)).slice(0, size)
              : "x".repeat(size);
        pipeline.mutate(() => {
          seedHistory(historyTurns);
          store.appendStream("response", `${text}\nreadyMARK `);
        });
        await awaitPaint(pipeline, "readyMARK");
        for (const phase of [
          { name: "first delta", marker: "firstDeltaMARK", iterations: 1 },
          { name: "steady deltas", marker: "steadyDeltaMARK", iterations: deltaFrames },
        ]) {
          const beforeBytes = pipeline.outputBytes();
          const result = await benchAsync(
            `${kind} ${shape} ${size} chars, ${historyTurns} turns, ${phase.name} -> painted frame`,
            async (iteration) => {
              const marker = `${phase.marker}${iteration}`;
              pipeline.mutate(() => store.appendStream("response", `\n${marker} words `));
              await awaitPaint(pipeline, marker);
            },
            { iterations: phase.iterations, warmupIterations: 0 },
          );
          results.push({
            ...result,
            metrics: {
              rendererOutputBytes: pipeline.outputBytes() - beforeBytes,
              historyTurns,
              answerCharacters: size,
            },
          });
        }
      } finally {
        await pipeline.close();
      }
    }
  }
  const pipeline = await mountPipeline(kind);
  try {
    for (const size of [1_000, 10_000, 50_000]) {
      let renderer = new InkStreamingRenderer("bench-local", false, DEFAULT_DISPLAY_CONFIG);
      try {
        results.push(
          await benchAsync(
            `${kind} ${size} chars, stream events + default buffer -> terminal`,
            async (iteration) => {
              const marker = `eventsMARK${size}_${iteration}`;
              const text = `${PROSE_PARAGRAPH.repeat(Math.ceil(size / PROSE_PARAGRAPH.length)).slice(0, size)}\n\n${marker}\n\n`;
              pipeline.mutate(() => {
                Effect.runSync(renderer.reset());
                store.clearOutputs();
                renderer = new InkStreamingRenderer("bench-local", false, DEFAULT_DISPLAY_CONFIG);
                Effect.runSync(
                  renderer.handleEvent({
                    type: "stream_start",
                    provider: "fixture",
                    model: "fixture",
                    timestamp: Date.now(),
                  }),
                );
                Effect.runSync(renderer.handleEvent({ type: "text_start" }));
                Effect.runSync(
                  renderer.handleEvent({
                    type: "text_chunk",
                    delta: text,
                    accumulated: text,
                    sequence: 0,
                  }),
                );
              });
              await awaitPaint(pipeline, marker);
            },
            { iterations: frames, warmupIterations: 0 },
          ),
        );
      } finally {
        pipeline.mutate(() => Effect.runSync(renderer.reset()));
      }
    }
    let fenceRenderer = new InkStreamingRenderer("bench-local", false, DEFAULT_DISPLAY_CONFIG);
    try {
      results.push(
        await benchAsync(
          `${kind} open fence buffer -> terminal`,
          async (iteration) => {
            const marker = `fenceMARK${iteration}`;
            const text = `\`\`\`ts\nconst value = 42;\n${marker}\n`;
            pipeline.mutate(() => {
              Effect.runSync(fenceRenderer.reset());
              store.clearOutputs();
              fenceRenderer = new InkStreamingRenderer(
                "bench-local",
                false,
                DEFAULT_DISPLAY_CONFIG,
              );
              Effect.runSync(
                fenceRenderer.handleEvent({
                  type: "stream_start",
                  provider: "fixture",
                  model: "fixture",
                  timestamp: Date.now(),
                }),
              );
              Effect.runSync(fenceRenderer.handleEvent({ type: "text_start" }));
              Effect.runSync(
                fenceRenderer.handleEvent({
                  type: "text_chunk",
                  delta: text,
                  accumulated: text,
                  sequence: 0,
                }),
              );
            });
            await awaitPaint(pipeline, marker);
          },
          { iterations: frames, warmupIterations: 0 },
        ),
      );
    } finally {
      pipeline.mutate(() => Effect.runSync(fenceRenderer.reset()));
    }
    pipeline.mutate(() => store.setStreamPacing(true));
    results.push(
      await benchAsync(
        `${kind} paced burst -> final token painted (real timers)`,
        async (iteration) => {
          const marker = `pacedMARK${iteration}`;
          pipeline.mutate(() =>
            store.appendStream("response", `\na provider burst with words ${marker} `),
          );
          await awaitPaint(pipeline, marker);
        },
        { iterations: frames, warmupIterations: 0 },
      ),
    );
    pipeline.mutate(() => {
      store.setStreamPacing(false);
    });
    results.push(
      await benchAsync(
        `${kind} viewport resize -> repainted content`,
        async (iteration) => {
          await pipeline.resize(iteration % 2 === 0 ? 80 : 120, iteration % 2 === 0 ? 24 : 40);
          await awaitPaint(pipeline, "pacedMARK");
        },
        { iterations: smoke ? 2 : 6, warmupIterations: 0 },
      ),
    );
  } finally {
    await pipeline.close();
  }
}

report("ui-pipeline", results);
