// Measures the per-delta cost of findLastSafeSplitPoint as the pending tail
// grows. The splitter re-scans the whole accumulated tail on every delta, so
// promoting a block costs O(tail^2) in total — bounded only by MAX_PENDING_TAIL.
// This bench tracks that per-call cost at each tail size. Run from the repo root:
//
//   bun src/cli/presentation/markdown-split.bench.ts
//   BENCH_CALLS=1000 bun src/cli/presentation/markdown-split.bench.ts
import { findLastSafeSplitPoint, MAX_PENDING_TAIL } from "./markdown-split";

const CALLS = Number(process.env["BENCH_CALLS"] ?? 300);
const TAIL_SIZES = [512, 1024, 2048, 4096, MAX_PENDING_TAIL];

const scenarios = {
  "open fence": (chars: number) => "```ts\n" + "const filler = 1;\n".repeat(Math.floor(chars / 18)),
  prose: (chars: number) =>
    "Lorem ipsum dolor sit amet consectetur. ".repeat(Math.floor(chars / 40)),
  "open list": (chars: number) => "- an unfinished list item\n".repeat(Math.floor(chars / 26)),
  table: (chars: number) => "| cell | cell | cell |\n".repeat(Math.floor(chars / 22)),
};

const results: Array<Record<string, number | string>> = [];
for (const [name, build] of Object.entries(scenarios)) {
  for (const tailSize of TAIL_SIZES) {
    const tail = build(tailSize);
    const durations: number[] = [];
    for (let call = 0; call < CALLS; call += 1) {
      const probe = tail + `token ${call} `;
      const start = performance.now();
      findLastSafeSplitPoint(probe);
      durations.push(performance.now() - start);
    }
    durations.sort((first, second) => first - second);
    const total = durations.reduce((sum, value) => sum + value, 0);
    results.push({
      scenario: name,
      tailChars: tail.length,
      meanMs: Number((total / CALLS).toFixed(4)),
      p95Ms: Number((durations[Math.floor(CALLS * 0.95)] ?? 0).toFixed(4)),
    });
  }
}

console.table(results);
