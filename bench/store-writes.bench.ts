/**
 * Measure unpaced streaming deltas and batched output through the production
 * store. Each sample uses a fresh store; enough warmup and measured calls keep
 * allocation and GC tails represented in p95 rather than a few rare samples.
 * Run with `bun run bench store-writes`; paced terminal delivery is measured
 * separately by ui-pipeline.bench.ts.
 */
import { outputEntries, streamDeltas } from "./corpus";
import { bench, report } from "./harness";
import { UIStore } from "../packages/cli/src/ui/store";

const entries = outputEntries(500);
const deltas = streamDeltas(500);
const sampling = { iterations: 200, warmupIterations: 40 } as const;

const results = [
  bench(
    "appendStream 500 deltas",
    () => {
      const store = new UIStore();
      for (const delta of deltas) {
        store.appendStream("response", delta);
      }
    },
    sampling,
  ),
  bench(
    "printOutput 500 entries + flush",
    () => {
      const store = new UIStore();
      for (const entry of entries) {
        store.printOutput(entry);
      }
      store.flushOutputBatchNow();
    },
    sampling,
  ),
];

report("store-writes", results);
