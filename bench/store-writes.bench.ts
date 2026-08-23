// Store write paths: per-delta appendStream and batched printOutput.
import { outputEntries, streamDeltas } from "./corpus";
import { bench, report } from "./harness";
import { UIStore } from "../src/cli/ui/store";

const entries = outputEntries(500);
const deltas = streamDeltas(500);

const results = [
  bench(
    "appendStream 500 deltas",
    () => {
      const store = new UIStore();
      for (const delta of deltas) {
        store.appendStream("response", delta);
      }
    },
    { iterations: 40 },
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
    { iterations: 40 },
  ),
];

report("store-writes", results);
