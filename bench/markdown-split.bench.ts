// findLastSafeSplitPoint runs over the whole accumulated tail on EVERY stream
// delta. The per-call rows show the cost by tail shape; the cumulative fold
// through reduceScrollback exposes the quadratic when a tail cannot promote.
import { markdownReply, streamDeltas } from "./corpus";
import { bench, report } from "./harness";
import { findLastSafeSplitPoint } from "../src/cli/presentation/markdown-split";
import {
  initialScrollbackState,
  reduceScrollback,
} from "../src/cli/ui/adapters/terminal-output-adapter";

const proseTail = markdownReply(8_000);
const openFenceTail = "```ts\n" + "const line = compute();\n".repeat(300);
const openListTail = "- item that keeps going\n".repeat(300);
const deltas = streamDeltas(3_000);

const results = [
  bench("split point, 8KB prose tail", () => {
    findLastSafeSplitPoint(proseTail);
  }),
  bench("split point, 7KB open fence", () => {
    findLastSafeSplitPoint(openFenceTail);
  }),
  bench("split point, 7KB open list", () => {
    findLastSafeSplitPoint(openListTail);
  }),
  bench(
    "reduceScrollback fold, 3k deltas",
    () => {
      let state = initialScrollbackState();
      let deltaIndex = 0;
      for (const delta of deltas) {
        deltaIndex += 1;
        state = reduceScrollback(state, {
          type: "appendStream",
          kind: "response",
          delta,
          nextId: `pending-${String(deltaIndex)}`,
          finalizeId: `finalized-${String(deltaIndex)}`,
        });
      }
    },
    { iterations: 20, warmupIterations: 2 },
  ),
];

report("markdown-split", results);
