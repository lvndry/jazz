// Measures the per-frame cost of transcriptRows while a reply streams into a
// settled transcript — the path the wrap cache (#395) and block identity
// sharing (#394) optimize. Run from the repo root:
//
//   bun src/cli/ui/fullscreen/transcript-streaming.bench.ts
//   BENCH_BLOCKS=200 BENCH_FRAMES=300 bun src/cli/ui/fullscreen/transcript-streaming.bench.ts
//
// Compare against a baseline by running the same file in a worktree checked
// out at the commit under test.
import { transcriptRows } from "./Transcript";
import type { Block } from "./types";

const VIEWPORT = { width: 120, height: 40 };
const SETTLED_COUNT = Number(process.env["BENCH_BLOCKS"] ?? 200);
const FRAMES = Number(process.env["BENCH_FRAMES"] ?? 300);

const paragraph =
  "The quick brown fox jumps over the lazy dog while `code spans` and **bold runs** " +
  "force the markdown pipeline to lex, wrap, and highlight every line it touches.\n\n";

function settledBlocks(): Block[] {
  const blocks: Block[] = [];
  for (let index = 0; index < SETTLED_COUNT; index += 1) {
    const seq = index * 3;
    blocks.push({ id: `u${index}`, seq, kind: "user", text: `question number ${index}?` });
    blocks.push({
      id: `t${index}`,
      seq: seq + 1,
      kind: "tool",
      app: "files",
      summary: `read src/module-${index}.ts`,
      status: "ok",
    });
    blocks.push({
      id: `a${index}`,
      seq: seq + 2,
      kind: "agent",
      markdown: paragraph.repeat(3),
    });
  }
  return blocks;
}

const settled = settledBlocks();

transcriptRows(settled, VIEWPORT);

function measure(frameOf: (frame: number) => readonly Block[]): Record<string, number> {
  const durations: number[] = [];
  for (let frame = 0; frame < FRAMES; frame += 1) {
    const blocks = frameOf(frame);
    const start = performance.now();
    transcriptRows(blocks, VIEWPORT);
    durations.push(performance.now() - start);
  }
  durations.sort((first, second) => first - second);
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    totalMs: Number(total.toFixed(1)),
    meanMsPerFrame: Number((total / FRAMES).toFixed(3)),
    p50Ms: Number((durations[Math.floor(durations.length * 0.5)] ?? 0).toFixed(3)),
    p95Ms: Number((durations[Math.floor(durations.length * 0.95)] ?? 0).toFixed(3)),
  };
}

let streamed = "";
const streaming = measure(() => {
  streamed += "token ";
  return [
    ...settled,
    {
      id: "stream",
      seq: settled.length * 3,
      kind: "agent",
      markdown: streamed,
      streaming: true,
    },
  ];
});

// A fresh array of the same block objects: every wrap hits the cache, so this
// isolates the per-frame walk over settled blocks from any wrapping at all.
const unchanged = measure(() => [...settled]);

console.log(
  JSON.stringify({
    settledBlocks: SETTLED_COUNT * 3,
    frames: FRAMES,
    streamingTail: streaming,
    unchangedBlocks: unchanged,
  }),
);
