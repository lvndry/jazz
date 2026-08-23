// Measures the cost of finding split points as a pending tail grows.
//
// Reported per scenario and tail size:
// - perCallMs: one findLastSafeSplitPoint call on a tail of that size.
// - growOneShotMs: growing a tail to that size in 40-char deltas, calling the
//   one-shot finder each time — it rescans the whole tail per delta, so a block
//   costs O(tail^2) to promote.
// - growScannerMs: the same growth through a StreamSplitScanner, which commits
//   each line once — O(tail). This is the path the streaming buffer takes.
//
// Run from the repo root:
//
//   bun src/cli/presentation/markdown-split.bench.ts
//   BENCH_CALLS=1000 bun src/cli/presentation/markdown-split.bench.ts
import {
  createStreamSplitScanner,
  findLastSafeSplitPoint,
  MAX_PENDING_TAIL,
} from "./markdown-split";

const CALLS = Number(process.env["BENCH_CALLS"] ?? 300);
const DELTA_CHARS = 40;
const TAIL_SIZES = [512, 1024, 2048, 4096, MAX_PENDING_TAIL];

const scenarios = {
  "open fence": (chars: number) => "```ts\n" + "const filler = 1;\n".repeat(Math.floor(chars / 18)),
  prose: (chars: number) =>
    "Lorem ipsum dolor sit amet consectetur. ".repeat(Math.floor(chars / 40)),
  "open list": (chars: number) => "- an unfinished list item\n".repeat(Math.floor(chars / 26)),
  table: (chars: number) => "| cell | cell | cell |\n".repeat(Math.floor(chars / 22)),
};

function meanPerCallMs(tail: string): number {
  let total = 0;
  for (let call = 0; call < CALLS; call += 1) {
    const probe = tail + `token ${call} `;
    const start = performance.now();
    findLastSafeSplitPoint(probe);
    total += performance.now() - start;
  }
  return total / CALLS;
}

function growTailMs(tail: string, split: (text: string) => number): number {
  const start = performance.now();
  for (let length = 0; length < tail.length; length += DELTA_CHARS) {
    split(tail.slice(0, Math.min(tail.length, length + DELTA_CHARS)));
  }
  return performance.now() - start;
}

const results: Array<Record<string, number | string>> = [];
for (const [name, build] of Object.entries(scenarios)) {
  for (const tailSize of TAIL_SIZES) {
    const tail = build(tailSize);
    const scanner = createStreamSplitScanner();
    results.push({
      scenario: name,
      tailChars: tail.length,
      perCallMs: Number(meanPerCallMs(tail).toFixed(4)),
      growOneShotMs: Number(growTailMs(tail, findLastSafeSplitPoint).toFixed(3)),
      growScannerMs: Number(growTailMs(tail, (text) => scanner.evaluate(text)).toFixed(3)),
    });
  }
}

console.table(results);
